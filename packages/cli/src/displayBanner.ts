// Export function to display banner and version

import fs from 'node:fs';
import path from 'node:path';

export function displayBanner(version: string | null = null, hideBanner = false) {
  // Color ANSI escape codes
  const b = '\x1b[38;5;27m';
  const lightblue = '\x1b[38;5;51m';
  const w = '\x1b[38;5;255m';
  const r = '\x1b[0m';
  const red = '\x1b[38;5;196m';
  let versionColor = lightblue;

  // assume __dirname doesnt exist
  const __dirname = path.resolve(import.meta.dirname, '..');

  if (!version) {
    const packageJsonPath = path.join(__dirname, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
    } else {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      version = packageJson.version;
    }
  }

  // if version includes "beta" or "alpha" then use red
  if (version.includes('beta') || version.includes('alpha')) {
    versionColor = red;
  }
  const banners = [
    // Banner 1
    `
${b}      _ _         ${w} _____ _____ ${r}
${b}     | (_)        ${w}|  _  /  ___|${r}
${b}  ___| |_ ______ _${w}| | | \\ \`--.${r} 
${b} / _ \\ | |_  / _\` ${w}| | | |\`--. \\${r}
${b}|  __/ | |/ / (_| ${w}\\ \\_/ /\\__/ /${r}
${b} \\___|_|_/___\\__,_|${w}\\___/\\____/ ${r}
      `,

    // Banner 2
    `
${b}          ###                                  ${w}  # ###       #######  ${r}
${b}         ###    #                            / ${w} /###     /       ###  ${r}
${b}          ##   ###                          /  ${w}/  ###   /         ##  ${r}
${b}          ##    #                          / ${w} ##   ###  ##        #   ${r}
${b}          ##                              /  ${w}###    ###  ###          ${r}
${b}   /##    ##  ###    ######      /###    ${w}##   ##     ## ## ###        ${r}
${b}  / ###   ##   ###  /#######    / ###  / ${w}##   ##     ##  ### ###      ${r}
${b} /   ###  ##    ## /      ##   /   ###/  ${w}##   ##     ##    ### ###    ${r}
${b}##    ### ##    ##        /   ##    ##   ${w}##   ##     ##      ### /##  ${r}
${b}########  ##    ##       /    ##    ##   ${w}##   ##     ##        #/ /## ${r}
${b}#######   ##    ##      ###   ##    ##   ${w} ##  ##     ##         #/ ## ${r}
${b}##        ##    ##       ###  ##    ##   ${w}  ## #      /           # /  ${r}
${b}####    / ##    ##        ### ##    /#   ${w}   ###     /  /##        /   ${r}
${b} ######/  ### / ### /      ##  ####/ ##  ${w}    ######/  /  ########/    ${r}
${b}  #####    ##/   ##/       ##   ###   ## ${w}      ###   /     #####      ${r}
${b}                           /             ${w}            |                ${r}
${b}                          /              ${w}             \)              ${r}
${b}                         /               ${w}                             ${r}
${b}                        /                ${w}                             ${r}
`,

    // Banner 3
    `
${b}      :::::::::::::      ::::::::::::::::::::    ::: ${w}    ::::::::  :::::::: ${r}
${b}     :+:       :+:          :+:         :+:   :+: :+:${w}  :+:    :+::+:    :+: ${r}
${b}    +:+       +:+          +:+        +:+   +:+   +:+${w} +:+    +:++:+         ${r}
${b}   +#++:++#  +#+          +#+       +#+   +#++:++#++:${w}+#+    +:++#++:++#++   ${r}
${b}  +#+       +#+          +#+      +#+    +#+     +#+${w}+#+    +#+       +#+    ${r}
${b} #+#       #+#          #+#     #+#     #+#     #+##${w}+#    #+##+#    #+#     ${r}
${b}##########################################     #### ${w}#######  ########       ${r}`,
  ];

  // Randomly select and log one banner
  const randomBanner = banners[Math.floor(Math.random() * banners.length)];

  if (!hideBanner) {
    console.log(randomBanner);
  } else {
    console.log(`*** elizaOS ***`);
  }

  // log the version
  console.log(`${versionColor}Version: ${version}${r}`);
}
