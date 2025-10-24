import chalk from 'chalk';

// Brand colors from Pluribit Brand Kit
const teal = chalk.rgb(78, 205, 196);      // #4ECDC4 - Primary (Vibrant Teal)
const charcoal = chalk.rgb(41, 50, 65);    // #293241 - Secondary (Charcoal Blue)
const coral = chalk.rgb(255, 107, 107);    // #FF6B6B - Accent (Coral Red)
const lightGray = chalk.rgb(240, 244, 248); // #F0F4F8 - Neutral 1



// Glitch/cypherpunk version with brand colors
export function printGlitchLogo() {
    const glitch = `
${coral('▓')}${teal('▓')}${charcoal('▓')} ${teal.bold('╔══════════════════════════════════════════════════════════╗')} ${charcoal('▓')}${teal('▓')}${coral('▓')}
${teal('▓')}${charcoal('▓')}  ${teal('║                                     ██')}                   ${teal('║')}  ${charcoal('▓')}${teal('▓')}
${charcoal('▓')}   ${teal.bold('║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║██║║║║║║║║║║║║║║║║║║║║')}   ${charcoal('▓')}
    ${teal('║')}${charcoal.bold('██████╗ ██╗     ██╗   ██╗██████╗ ██╗')}${teal.bold('████║   ')}${charcoal.bold(' ██╗████████╗')} ${teal('║')}
    ${teal('║')}${charcoal.bold('██╔══██╗██║     ██║   ██║██╔══██╗██║')}${teal.bold('║██ ╚══╗')}${charcoal.bold(' ██║╚══██╔══╝')} ${teal('║')}
    ${teal('║')}${charcoal.bold('██████╔╝██║     ██║   ██║██████╔╝██║')}${teal.bold('║██████║')}${charcoal.bold( ' ██║   ██║')}    ${teal('║')}
    ${teal('║')}${charcoal.bold('██╔═══╝ ██║     ██║   ██║██╔══██╗██║')}${teal.bold('║██║║║██║║║║║║║║║║║║║║')}${teal('║║║║')}
    ${teal('║')}${charcoal.bold('██║     ███████╗╚██████╔╝██║  ██║██║')}${teal.bold('║██████║')}${charcoal.bold(' ██║   ██║')}    ${teal('║')}
    ${teal('║')}${charcoal.bold('╚═╝     ╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝')}${teal.bold('╚══════╝')}${charcoal.bold(' ╚═╝   ╚═╝')}    ${teal('║')}
${charcoal('▓')}   ${teal('║')}${teal.bold('║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║║')}${teal('║')}   ${charcoal('▓')}
${teal('▓')}${charcoal('▓')}  ${teal('║')}                 ${charcoal.bold('Digital cash, native to the web')}          ${teal('║')}  ${charcoal('▓')}${teal('▓')}
${coral('▓')}${teal('▓')}${charcoal('▓')} ${teal('╚══════════════════════════════════════════════════════════╝')} ${charcoal('▓')}${teal('▓')}${coral('▓')}

        ${coral('▶')} ${chalk.dim('Decentralized • Secure • Private')} ${coral('◀')}
        ${chalk.dim.cyan('      [Proof of Time]')}
`;
    console.log(glitch);
}

// Minimal version - symbol + wordmark only
export function printMinimalLogo() {
    console.log('\n');
    console.log(`    ${teal.bold('ƀ')} ${charcoal.bold('Pluribit')}`);
    console.log(`    ${lightGray('Digital cash, native to the web')}`);
    console.log('\n');
}





