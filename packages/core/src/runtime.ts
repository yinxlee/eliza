import { join } from "node:path";
import { v4 as uuidv4 } from "uuid";
import { bootstrapPlugin } from "./bootstrap";
import { settings } from "./environment";
import { createUniqueUuid, handlePluginImporting, logger } from "./index";
import { MemoryManager } from "./memory";
import { splitChunks } from "./prompts";
import {
	type Action,
	type Agent,
	ChannelType,
	type Character,
	type Evaluator,
	type HandlerCallback,
	type IAgentRuntime,
	type IDatabaseAdapter,
	type IMemoryManager,
	type KnowledgeItem,
	type Memory,
	MemoryType,
	type ModelType,
	ModelTypes,
	type Plugin,
	type Provider,
	type Room,
	type Route,
	type Service,
	type ServiceType,
	type State,
	type TaskWorker,
	type UUID,
	type World,
} from "./types";
import { stringToUuid } from "./uuid";

/**
 * Represents the runtime environment for an agent, handling message processing,
 * action registration, and interaction with external services like OpenAI and Supabase.
 */
/**
 * Represents the runtime environment for an agent.
 * @class
 * @implements { IAgentRuntime }
 * @property { number } #conversationLength - The maximum length of a conversation.
 * @property { UUID } agentId - The unique identifier for the agent.
 * @property { Character } character - The character associated with the agent.
 * @property { IDatabaseAdapter } databaseAdapter - The adapter for interacting with the database.
 * @property {Action[]} actions - The list of actions available to the agent.
 * @property {Evaluator[]} evaluators - The list of evaluators for decision making.
 * @property {Provider[]} providers - The list of providers for external services.
 * @property {Plugin[]} plugins - The list of plugins to extend functionality.
 */
export class AgentRuntime implements IAgentRuntime {
	readonly #conversationLength = 32 as number;
	readonly agentId: UUID;
	readonly character: Character;
	public databaseAdapter!: IDatabaseAdapter;
	readonly actions: Action[] = [];
	readonly evaluators: Evaluator[] = [];
	readonly providers: Provider[] = [];
	readonly plugins: Plugin[] = [];
	events: Map<string, ((params: any) => void)[]> = new Map();
	stateCache = new Map<
		UUID,
		{
			values: { [key: string]: any };
			data: { [key: string]: any };
			text: string;
		}
	>();

	readonly fetch = fetch;
	services: Map<ServiceType, Service> = new Map();

	public adapter: IDatabaseAdapter;

	private readonly knowledgeRoot: string;

	models = new Map<string, ((params: any) => Promise<any>)[]>();
	routes: Route[] = [];

	private taskWorkers = new Map<string, TaskWorker>();

	constructor(opts: {
		conversationLength?: number;
		agentId?: UUID;
		character?: Character;
		plugins?: Plugin[];
		fetch?: typeof fetch;
		databaseAdapter?: IDatabaseAdapter;
		adapter?: IDatabaseAdapter;
		events?: { [key: string]: ((params: any) => void)[] };
		ignoreBootstrap?: boolean;
	}) {
		// use the character id if it exists, otherwise use the agentId if it is passed in, otherwise use the character name
		this.agentId =
			opts.character?.id ??
			opts?.agentId ??
			stringToUuid(opts.character?.name ?? uuidv4());
		this.character = opts.character;

		logger.debug(`[AgentRuntime] Process working directory: ${process.cwd()}`);

		this.knowledgeRoot =
			typeof process !== "undefined" && process.cwd
				? join(process.cwd(), "..", "characters", "knowledge")
				: "./characters/knowledge";

		logger.debug(`[AgentRuntime] Process knowledgeRoot: ${this.knowledgeRoot}`);

		this.#conversationLength =
			opts.conversationLength ?? this.#conversationLength;

		if (opts.databaseAdapter) {
			this.registerDatabaseAdapter(opts.databaseAdapter);
		}

		logger.success(`Agent ID: ${this.agentId}`);

		this.fetch = (opts.fetch as typeof fetch) ?? this.fetch;

		// Initialize adapter from options or empty array if not provided
		this.adapter = opts.adapter;

		// Register plugins from options or empty array
		const plugins = opts?.plugins ?? [];

		// Add bootstrap plugin if not explicitly ignored
		if (!opts?.ignoreBootstrap) {
			plugins.push(bootstrapPlugin);
		}

		// Store plugins in the array but don't initialize them yet
		this.plugins = plugins;
	}

	/**
	 * Registers a plugin with the runtime and initializes its components
	 * @param plugin The plugin to register
	 */
	async registerPlugin(plugin: Plugin): Promise<void> {
		if (!plugin) {
			return;
		}

		// Add to plugins array if not already present - but only if it was not passed there initially
		// (otherwise we can't add to readonly array)
		if (!this.plugins.some((p) => p.name === plugin.name)) {
			// Push to plugins array - this works because we're modifying the array, not reassigning it
			this.plugins.push(plugin);
		}

		// Register plugin adapter
		if (plugin.adapter) {
			this.registerDatabaseAdapter(plugin.adapter);
		}

		// Register plugin actions
		if (plugin.actions) {
			for (const action of plugin.actions) {
				this.registerAction(action);
			}
		}

		// Register plugin evaluators
		if (plugin.evaluators) {
			for (const evaluator of plugin.evaluators) {
				this.registerEvaluator(evaluator);
			}
		}

		// Register plugin providers
		if (plugin.providers) {
			for (const provider of plugin.providers) {
				this.registerContextProvider(provider);
			}
		}

		// Register plugin models
		if (plugin.models) {
			for (const [modelType, handler] of Object.entries(plugin.models)) {
				this.registerModel(
					modelType as ModelType,
					handler as (params: any) => Promise<any>,
				);
			}
		}

		// Register plugin routes
		if (plugin.routes) {
			for (const route of plugin.routes) {
				this.routes.push(route);
			}
		}

		// Register plugin events
		if (plugin.events) {
			for (const [eventName, eventHandlers] of Object.entries(plugin.events)) {
				for (const eventHandler of eventHandlers) {
					this.registerEvent(eventName, eventHandler);
				}
			}
		}

		// Register plugin services
		if (plugin.services) {
			await Promise.all(
				plugin.services.map((service) => this.registerService(service)),
			);
		}

		// Initialize plugin if it has an init function
		if (plugin.init) {
			await plugin.init(plugin.config, this);
		}
	}

	getAllServices(): Map<ServiceType, Service> {
		return this.services;
	}

	async stop() {
		logger.debug(`runtime::stop - character ${this.character.name}`);

		// Stop all registered clients
		for (const [serviceName, service] of this.services) {
			logger.log(`runtime::stop - requesting service stop for ${serviceName}`);
			await service.stop();
		}
	}

	async initialize() {
		// First create the agent entity directly
		try {
			await this.getDatabaseAdapter().init();

			await this.getDatabaseAdapter().ensureAgentExists(
				this.character as Partial<Agent>,
			);

			// No need to transform agent's own ID
			const agentEntity = await this.getDatabaseAdapter().getEntityById(
				this.agentId,
			);

			if (!agentEntity) {
				const created = await this.getDatabaseAdapter().createEntity({
					id: this.agentId,
					agentId: this.agentId,
					names: Array.from(
						new Set([this.character.name].filter(Boolean)),
					) as string[],
					metadata: {},
				});

				if (!created) {
					throw new Error(`Failed to create entity for agent ${this.agentId}`);
				}

				logger.success(
					`Agent entity created successfully for ${this.character.name}`,
				);
			}
		} catch (error) {
			logger.error(
				`Failed to create agent entity: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			throw error;
		}

		// Track registered plugins to avoid duplicates
		const registeredPluginNames = new Set<string>();

		// Load and register plugins from character configuration
		const pluginRegistrationPromises = [];

		if (this.character.plugins) {
			const characterPlugins = (await handlePluginImporting(
				this.character.plugins,
			)) as Plugin[];

			// Register each character plugin
			for (const plugin of characterPlugins) {
				if (plugin && !registeredPluginNames.has(plugin.name)) {
					registeredPluginNames.add(plugin.name);
					pluginRegistrationPromises.push(this.registerPlugin(plugin));
				}
			}
		}

		// Register plugins that were provided in the constructor
		for (const plugin of [...this.plugins]) {
			if (plugin && !registeredPluginNames.has(plugin.name)) {
				registeredPluginNames.add(plugin.name);
				pluginRegistrationPromises.push(this.registerPlugin(plugin));
			}
		}

		// Create room for the agent and register all plugins in parallel
		try {
			await Promise.all([
				this.ensureRoomExists({
					id: this.agentId,
					name: this.character.name,
					source: "self",
					type: ChannelType.SELF,
				}),
				...pluginRegistrationPromises,
			]);
		} catch (error) {
			logger.error(
				`Failed to initialize: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			throw error;
		}

		// Add agent as participant in its own room
		try {
			// No need to transform agent ID
			const participants =
				await this.getDatabaseAdapter().getParticipantsForRoom(this.agentId);
			if (!participants.includes(this.agentId)) {
				const added = await this.getDatabaseAdapter().addParticipant(
					this.agentId,
					this.agentId,
				);
				if (!added) {
					throw new Error(
						`Failed to add agent ${this.agentId} as participant to its own room`,
					);
				}
				logger.success(
					`Agent ${this.character.name} linked to its own room successfully`,
				);
			}
		} catch (error) {
			logger.error(
				`Failed to add agent as participant: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			throw error;
		}

		// Process character knowledge
		if (this.character?.knowledge && this.character.knowledge.length > 0) {
			const stringKnowledge = this.character.knowledge.filter(
				(item): item is string => typeof item === "string",
			);
			await this.processCharacterKnowledge(stringKnowledge);
		}

		// Check if TEXT_EMBEDDING model is registered
		const embeddingModel = this.getModel(ModelTypes.TEXT_EMBEDDING);
		if (!embeddingModel) {
			logger.warn(
				`[AgentRuntime][${this.character.name}] No TEXT_EMBEDDING model registered. Skipping embedding dimension setup.`,
			);
		} else {
			// Only run ensureEmbeddingDimension if we have an embedding model
			await this.ensureEmbeddingDimension();
		}
	}

	private async handleProcessingError(error: any, context: string) {
		logger.error(
			`Error ${context}:`,
			error?.message || error || "Unknown error",
		);
		throw error;
	}

	private async checkExistingKnowledge(knowledgeId: UUID): Promise<boolean> {
		const existingDocument =
			await this.getMemoryManager("documents").getMemoryById(knowledgeId);
		return !!existingDocument;
	}

	async getKnowledge(message: Memory): Promise<KnowledgeItem[]> {
		// Add validation for message
		if (!message?.content?.text) {
			logger.warn("Invalid message for knowledge query:", {
				message,
				content: message?.content,
				text: message?.content?.text,
			});
			return [];
		}

		// Validate processed text
		if (!message?.content?.text || message?.content?.text.trim().length === 0) {
			logger.warn("Empty text for knowledge query");
			return [];
		}

		const embedding = await this.useModel(
			ModelTypes.TEXT_EMBEDDING,
			message?.content?.text,
		);
		const fragments = await this.getMemoryManager("knowledge").searchMemories({
			embedding,
			roomId: message.agentId,
			count: 5,
			match_threshold: 0.1,
		});

		const uniqueSources = [
			...new Set(
				fragments.map((memory) => {
					logger.log(
						`Matched fragment: ${memory.content.text} with similarity: ${memory.similarity}`,
					);
					return memory.content.source;
				}),
			),
		];

		const knowledgeDocuments = await Promise.all(
			uniqueSources.map((source) =>
				this.getMemoryManager("documents").getMemoryById(source as UUID),
			),
		);

		return knowledgeDocuments
			.filter((memory) => memory !== null)
			.map((memory) => ({ id: memory.id, content: memory.content }));
	}

	async addKnowledge(
		item: KnowledgeItem,
		options = {
			targetTokens: 3000,
			overlap: 200,
			modelContextSize: 4096,
		},
	) {
		// First store the document
		const documentMemory: Memory = {
			id: item.id,
			agentId: this.agentId,
			roomId: this.agentId,
			entityId: this.agentId,
			content: item.content,
			metadata: {
				type: MemoryType.DOCUMENT,
				timestamp: Date.now(),
			},
		};

		await this.getMemoryManager("documents").createMemory(documentMemory);

		// Create fragments using splitChunks
		const fragments = await splitChunks(
			item.content.text,
			options.targetTokens,
			options.overlap,
		);

		// Store each fragment with link to source document
		for (let i = 0; i < fragments.length; i++) {
			const fragmentMemory: Memory = {
				id: createUniqueUuid(this, `${item.id}-fragment-${i}`),
				agentId: this.agentId,
				roomId: this.agentId,
				entityId: this.agentId,
				content: { text: fragments[i] },
				metadata: {
					type: MemoryType.FRAGMENT,
					documentId: item.id, // Link to source document
					position: i, // Keep track of order
					timestamp: Date.now(),
				},
			};

			await this.getMemoryManager("knowledge").createMemory(fragmentMemory);
		}
	}

	async processCharacterKnowledge(items: string[]) {
		for (const item of items) {
			try {
				const knowledgeId = createUniqueUuid(this, item);
				if (await this.checkExistingKnowledge(knowledgeId)) {
					continue;
				}

				logger.info(
					"Processing knowledge for ",
					this.character.name,
					" - ",
					item.slice(0, 100),
				);

				await this.addKnowledge({
					id: knowledgeId,
					content: {
						text: item,
					},
				});
			} catch (error) {
				await this.handleProcessingError(
					error,
					"processing character knowledge",
				);
			}
		}
	}

	setSetting(
		key: string,
		value: string | boolean | null | any,
		secret = false,
	) {
		if (secret) {
			this.character.secrets[key] = value;
		} else {
			this.character.settings[key] = value;
		}
	}

	getSetting(key: string): string | boolean | null | any {
		const value =
			this.character.secrets?.[key] ||
			this.character.settings?.[key] ||
			this.character.settings?.secrets?.[key] ||
			settings[key];

		if (value === "true") return true;
		if (value === "false") return false;
		return value || null;
	}

	/**
	 * Get the number of messages that are kept in the conversation buffer.
	 * @returns The number of recent messages to be kept in memory.
	 */
	getConversationLength() {
		return this.#conversationLength;
	}

	registerDatabaseAdapter(adapter: IDatabaseAdapter) {
		if (this.adapter) {
			logger.warn(
				"Database adapter already registered. Additional adapters will be ignored. This may lead to unexpected behavior.",
			);
		} else {
			this.adapter = adapter;
		}
	}

	getDatabaseAdapter() {
		return this.adapter;
	}

	/**
	 * Register a provider for the agent to use.
	 * @param provider The provider to register.
	 */
	registerProvider(provider: Provider) {
		this.providers.push(provider);
	}

	/**
	 * Register an action for the agent to perform.
	 * @param action The action to register.
	 */
	registerAction(action: Action) {
		logger.success(
			`${this.character.name}(${this.agentId}) - Registering action: ${action.name}`,
		);
		this.actions.push(action);
	}

	/**
	 * Register an evaluator to assess and guide the agent's responses.
	 * @param evaluator The evaluator to register.
	 */
	registerEvaluator(evaluator: Evaluator) {
		this.evaluators.push(evaluator);
	}

	/**
	 * Register a context provider to provide context for message generation.
	 * @param provider The context provider to register.
	 */
	registerContextProvider(provider: Provider) {
		this.providers.push(provider);
	}

	/**
	 * Process the actions of a message.
	 * @param message The message to process.
	 * @param responses The array of response memories to process actions from.
	 * @param state Optional state object for the action processing.
	 * @param callback Optional callback handler for action results.
	 */
	async processActions(
		message: Memory,
		responses: Memory[],
		state?: State,
		callback?: HandlerCallback,
	): Promise<void> {
		for (const response of responses) {
			if (!response.content?.actions || response.content.actions.length === 0) {
				logger.warn("No action found in the response content.");
				continue;
			}

			const actions = response.content.actions;

			function normalizeAction(action: string) {
				return action.toLowerCase().replace("_", "");
			}
			logger.success(
				`Found actions: ${this.actions.map((a) => normalizeAction(a.name))}`,
			);

			for (const responseAction of actions) {
				state = await this.composeState(message, ["RECENT_MESSAGES"]);

				logger.success(`Calling action: ${responseAction}`);
				const normalizedResponseAction = normalizeAction(responseAction);
				let action = this.actions.find(
					(a: { name: string }) =>
						normalizeAction(a.name).includes(normalizedResponseAction) || // the || is kind of a fuzzy match
						normalizedResponseAction.includes(normalizeAction(a.name)), //
				);

				if (action) {
					logger.success(`Found action: ${action?.name}`);
				} else {
					logger.error(`No action found for: ${responseAction}`);
				}

				if (!action) {
					logger.info("Attempting to find action in similes.");
					for (const _action of this.actions) {
						const simileAction = _action.similes?.find(
							(simile) =>
								simile
									.toLowerCase()
									.replace("_", "")
									.includes(normalizedResponseAction) ||
								normalizedResponseAction.includes(
									simile.toLowerCase().replace("_", ""),
								),
						);
						if (simileAction) {
							action = _action;
							logger.success(`Action found in similes: ${action.name}`);
							break;
						}
					}
				}

				if (!action) {
					logger.error("No action found in", JSON.stringify(response));
					continue;
				}

				if (!action.handler) {
					logger.error(`Action ${action.name} has no handler.`);
					continue;
				}

				try {
					logger.info(`Executing handler for action: ${action.name}`);

					await action.handler(this, message, state, {}, callback, responses);

					logger.success(`Action ${action.name} executed successfully.`);

					// log to database
					await this.getDatabaseAdapter().log({
						entityId: message.entityId,
						roomId: message.roomId,
						type: "action",
						body: {
							action: action.name,
							message: message.content.text,
							messageId: message.id,
							state,
							responses,
						},
					});
				} catch (error) {
					logger.error(error);
					throw error;
				}
			}
		}
	}

	/**
	 * Evaluate the message and state using the registered evaluators.
	 * @param message The message to evaluate.
	 * @param state The state of the agent.
	 * @param didRespond Whether the agent responded to the message.~
	 * @param callback The handler callback
	 * @returns The results of the evaluation.
	 */
	async evaluate(
		message: Memory,
		state: State,
		didRespond?: boolean,
		callback?: HandlerCallback,
		responses?: Memory[],
	) {
		const evaluatorPromises = this.evaluators.map(
			async (evaluator: Evaluator) => {
				if (!evaluator.handler) {
					return null;
				}
				if (!didRespond && !evaluator.alwaysRun) {
					return null;
				}
				const result = await evaluator.validate(this, message, state);

				if (result) {
					return evaluator;
				}
				return null;
			},
		);

		const evaluators = (await Promise.all(evaluatorPromises)).filter(
			Boolean,
		) as Evaluator[];

		// get the evaluators that were chosen by the response handler

		if (evaluators.length === 0) {
			return [];
		}

		state = await this.composeState(message, ["RECENT_MESSAGES", "EVALUATORS"]);

		await Promise.all(
			evaluators.map(async (evaluator) => {
				if (evaluator.handler) {
					await evaluator.handler(
						this,
						message,
						state,
						{},
						callback,
						responses,
					);
					// log to database
					await this.getDatabaseAdapter().log({
						entityId: message.entityId,
						roomId: message.roomId,
						type: "evaluator",
						body: {
							evaluator: evaluator.name,
							messageId: message.id,
							message: message.content.text,
							state,
						},
					});
				}
			}),
		);

		return evaluators;
	}

	async ensureParticipantInRoom(entityId: UUID, roomId: UUID) {
		// Make sure entity exists in database before adding as participant
		const entity = await this.getDatabaseAdapter().getEntityById(entityId);
		if (!entity) {
			throw new Error(`User ${entityId} not found`);
		}
		// Get current participants
		const participants =
			await this.getDatabaseAdapter().getParticipantsForRoom(roomId);

		// Only add if not already a participant
		if (!participants.includes(entityId)) {
			// Add participant using the tenant-specific ID that now exists in the entities table
			const added = await this.getDatabaseAdapter().addParticipant(
				entityId,
				roomId,
			);

			if (!added) {
				throw new Error(
					`Failed to add participant ${entityId} to room ${roomId}`,
				);
			}

			if (entityId === this.agentId) {
				logger.log(
					`Agent ${this.character.name} linked to room ${roomId} successfully.`,
				);
			} else {
				logger.log(`User ${entityId} linked to room ${roomId} successfully.`);
			}
		}
	}

	async ensureConnection({
		entityId,
		roomId,
		userName,
		name,
		source,
		type,
		channelId,
		serverId,
		worldId,
	}: {
		entityId: UUID;
		roomId: UUID;
		userName?: string;
		name?: string;
		source?: string;
		type?: ChannelType;
		channelId?: string;
		serverId?: string;
		worldId?: UUID;
	}) {
		if (entityId === this.agentId) {
			throw new Error("Agent should not connect to itself");
		}

		if (!worldId && serverId) {
			worldId = createUniqueUuid(this, serverId);
		}

		const names = [name, userName];
		const metadata = {
			[source]: {
				name: name,
				userName: userName,
			},
		};

		const entity = await this.getDatabaseAdapter().getEntityById(entityId);

		if (!entity) {
			await this.getDatabaseAdapter().createEntity({
				id: entityId,
				names,
				metadata,
				agentId: this.agentId,
			});
		}

		// Ensure world exists if worldId is provided
		if (worldId) {
			await this.ensureWorldExists({
				id: worldId,
				name: serverId
					? `World for server ${serverId}`
					: `World for room ${roomId}`,
				agentId: this.agentId,
				serverId: serverId || "default",
				metadata,
			});
		}

		// Ensure room exists
		await this.ensureRoomExists({
			id: roomId,
			source,
			type,
			channelId,
			serverId,
			worldId,
		});

		// Now add participants using the original IDs (will be transformed internally)
		try {
			await this.ensureParticipantInRoom(entityId, roomId);
			await this.ensureParticipantInRoom(this.agentId, roomId);
		} catch (error) {
			logger.error(
				`Failed to add participants: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			throw error;
		}
	}

	/**
	 * Ensure the existence of a world.
	 */
	async ensureWorldExists({ id, name, serverId, metadata }: World) {
		try {
			const world = await this.getDatabaseAdapter().getWorld(id);
			if (!world) {
				logger.info("Creating world:", {
					id,
					name,
					serverId,
					agentId: this.agentId,
				});
				await this.getDatabaseAdapter().createWorld({
					id,
					name,
					agentId: this.agentId,
					serverId: serverId || "default",
					metadata,
				});
				logger.info(`World ${id} created successfully.`);
			}
		} catch (error) {
			logger.error(
				`Failed to ensure world exists: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			throw error;
		}
	}

	/**
	 * Ensure the existence of a room between the agent and a user. If no room exists, a new room is created and the user
	 * and agent are added as participants. The room ID is returned.
	 * @param entityId - The user ID to create a room with.
	 * @returns The room ID of the room between the agent and the user.
	 * @throws An error if the room cannot be created.
	 */
	async ensureRoomExists({
		id,
		name,
		source,
		type,
		channelId,
		serverId,
		worldId,
	}: Room) {
		const room = await this.getDatabaseAdapter().getRoom(id);
		if (!room) {
			await this.getDatabaseAdapter().createRoom({
				id,
				name,
				agentId: this.agentId,
				source,
				type,
				channelId,
				serverId,
				worldId,
			});
			logger.log(`Room ${id} created successfully.`);
		}
	}

	/**
	 * Composes the agent's state by gathering data from enabled providers.
	 * @param message - The message to use as context for state composition
	 * @param filterList - Optional list of provider names to include, filtering out all others
	 * @param includeList - Optional list of private provider names to include that would otherwise be filtered out
	 * @returns A State object containing provider data, values, and text
	 */
	async composeState(
		message: Memory,
		filterList: string[] | null = null, // only get providers that are in the filterList
		includeList: string[] | null = null, // include providers that are private, dynamic or otherwise not included by default
	): Promise<State> {
		// Get cached state for this message ID first
		const cachedState = (await this.stateCache.get(message.id)) || {
			values: {},
			data: {},
			text: "",
		};

		// Get existing provider names from cache (if any)
		const existingProviderNames = cachedState.data.providers
			? Object.keys(cachedState.data.providers)
			: [];

		// Step 1: Determine base set of providers to fetch
		const providerNames = new Set<string>();

		if (filterList && filterList.length > 0) {
			// If filter list provided, start with just those providers
			filterList.forEach((name) => providerNames.add(name));
		} else {
			// Otherwise, start with all non-private, non-dynamic providers that aren't cached
			this.providers
				.filter(
					(p) =>
						!p.private && !p.dynamic && !existingProviderNames.includes(p.name),
				)
				.forEach((p) => providerNames.add(p.name));
		}

		// Step 2: Always add providers from include list
		if (includeList && includeList.length > 0) {
			includeList.forEach((name) => providerNames.add(name));
		}

		// Get the actual provider objects and sort by position
		const providersToGet = Array.from(
			new Set(this.providers.filter((p) => providerNames.has(p.name))),
		).sort((a, b) => (a.position || 0) - (b.position || 0));

		// Fetch data from selected providers
		const providerData = await Promise.all(
			providersToGet.map(async (provider) => {
				const start = Date.now();
				const result = await provider.get(this, message, cachedState);
				const duration = Date.now() - start;
				logger.warn(`${provider.name} Provider took ${duration}ms to respond`);
				return {
					...result,
					providerName: provider.name,
				};
			}),
		);

		// Extract existing provider data from cache
		const existingProviderData = cachedState.data.providers || {};

		// Create a combined provider values structure that preserves all cached data
		// but updates with any newly fetched provider data
		const combinedValues = { ...existingProviderData };

		// Update with newly fetched provider data
		for (const result of providerData) {
			combinedValues[result.providerName] = result.values || {};
		}

		// Collect provider text from newly fetched providers
		const newProvidersText = providerData
			.map((result) => result.text)
			.filter((text) => text !== "")
			.join("\n");

		// Combine with existing text if available
		let providersText = "";
		if (cachedState.text && newProvidersText) {
			providersText = `${cachedState.text}\n${newProvidersText}`;
		} else if (newProvidersText) {
			providersText = newProvidersText;
		} else if (cachedState.text) {
			providersText = cachedState.text;
		}

		// Prepare final values
		const values = {
			...(cachedState.values || {}),
		};

		// Safely merge all provider values
		for (const providerName in combinedValues) {
			const providerValues = combinedValues[providerName];
			if (providerValues && typeof providerValues === "object") {
				Object.assign(values, providerValues);
			}
		}

		// Assemble and cache the new state
		const newState = {
			values: {
				...values,
				providers: providersText,
			},
			data: {
				...(cachedState.data || {}),
				providers: combinedValues,
			},
			text: providersText,
		} as State;

		// Cache the result for future use
		this.stateCache.set(message.id, newState);
		return newState;
	}

	getMemoryManager(tableName: string): IMemoryManager | null {
		return new MemoryManager({
			runtime: this,
			tableName: tableName,
		});
	}

	getService<T extends Service>(service: ServiceType): T | null {
		const serviceInstance = this.services.get(service);
		if (!serviceInstance) {
			logger.error(`Service ${service} not found`);
			return null;
		}
		return serviceInstance as T;
	}

	async registerService(service: typeof Service): Promise<void> {
		const serviceType = service.serviceType as ServiceType;
		if (!serviceType) {
			return;
		}
		logger.log(
			`${this.character.name}(${this.agentId}) - Registering service:`,
			serviceType,
		);

		if (this.services.has(serviceType)) {
			logger.warn(
				`${this.character.name}(${this.agentId}) - Service ${serviceType} is already registered. Skipping registration.`,
			);
			return;
		}

		const serviceInstance = await service.start(this);

		// Add the service to the services map
		this.services.set(serviceType, serviceInstance);
		logger.success(
			`${this.character.name}(${this.agentId}) - Service ${serviceType} registered successfully`,
		);
	}

	registerModel(modelType: ModelType, handler: (params: any) => Promise<any>) {
		const modelKey =
			typeof modelType === "string" ? modelType : ModelTypes[modelType];
		if (!this.models.has(modelKey)) {
			this.models.set(modelKey, []);
		}
		this.models.get(modelKey)?.push(handler);
	}

	getModel(
		modelType: ModelType,
	): ((runtime: IAgentRuntime, params: any) => Promise<any>) | undefined {
		const modelKey =
			typeof modelType === "string" ? modelType : ModelTypes[modelType];
		const models = this.models.get(modelKey);
		if (!models?.length) {
			return undefined;
		}
		return models[0];
	}

	async useModel(modelType: ModelType, params: any): Promise<any> {
		const modelKey =
			typeof modelType === "string" ? modelType : ModelTypes[modelType];
		const model = this.getModel(modelKey);
		if (!model) {
			throw new Error(`No handler found for delegate type: ${modelKey}`);
		}

		// Call the model
		const response = await model(this, params);

		await this.getDatabaseAdapter().log({
			entityId: this.agentId,
			roomId: this.agentId,
			body: {
				modelType,
				modelKey,
				params: params ? Object.keys(params) : [],
				response:
					Array.isArray(response) &&
					response.every((x) => typeof x === "number")
						? "[array]"
						: response,
			},
			type: `useModel:${modelType}`,
		});

		return response;
	}

	registerEvent(event: string, handler: (params: any) => void) {
		if (!this.events.has(event)) {
			this.events.set(event, []);
		}
		this.events.get(event)?.push(handler);
	}

	getEvent(event: string): ((params: any) => void)[] | undefined {
		return this.events.get(event);
	}

	emitEvent(event: string | string[], params: any) {
		// Handle both single event string and array of event strings
		const events = Array.isArray(event) ? event : [event];

		// Call handlers for each event
		for (const eventName of events) {
			const eventHandlers = this.events.get(eventName);

			if (eventHandlers) {
				for (const handler of eventHandlers) {
					handler(params);
				}
			}
		}
	}

	async ensureEmbeddingDimension() {
		logger.debug(
			`[AgentRuntime][${this.character.name}] Starting ensureEmbeddingDimension`,
		);

		if (!this.getDatabaseAdapter()) {
			throw new Error(
				`[AgentRuntime][${this.character.name}] Database adapter not initialized before ensureEmbeddingDimension`,
			);
		}

		try {
			const model = this.getModel(ModelTypes.TEXT_EMBEDDING);
			if (!model) {
				throw new Error(
					`[AgentRuntime][${this.character.name}] No TEXT_EMBEDDING model registered`,
				);
			}

			logger.debug(
				`[AgentRuntime][${this.character.name}] Getting embedding dimensions`,
			);
			const embedding = await this.useModel(ModelTypes.TEXT_EMBEDDING, null);

			if (!embedding || !embedding.length) {
				throw new Error(
					`[AgentRuntime][${this.character.name}] Invalid embedding received`,
				);
			}

			logger.debug(
				`[AgentRuntime][${this.character.name}] Setting embedding dimension: ${embedding.length}`,
			);
			await this.getDatabaseAdapter().ensureEmbeddingDimension(
				embedding.length,
			);
			logger.debug(
				`[AgentRuntime][${this.character.name}] Successfully set embedding dimension`,
			);
		} catch (error) {
			logger.info(
				`[AgentRuntime][${this.character.name}] Error in ensureEmbeddingDimension:`,
				error,
			);
			throw error;
		}
	}

	registerTaskWorker(taskHandler: TaskWorker): void {
		if (this.taskWorkers.has(taskHandler.name)) {
			logger.warn(
				`Task definition ${taskHandler.name} already registered. Will be overwritten.`,
			);
		}
		this.taskWorkers.set(taskHandler.name, taskHandler);
	}

	getTaskWorker(name: string): TaskWorker | undefined {
		return this.taskWorkers.get(name);
	}
}
