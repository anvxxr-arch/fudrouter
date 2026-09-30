/** @type {import("prettier").Config} */
const config = {
	useTabs: true,
	singleQuote: true,
	trailingComma: 'none',
	printWidth: 100,
	plugins: ['prettier-plugin-svelte', 'prettier-plugin-tailwindcss'],
	overrides: [{ files: '*.svelte', options: { parser: 'svelte' } }],
	// tokens.css, NOT layout.css. The plugin resolves every @import it can reach,
	// and layout.css pulls in '(public)/public-pages.css' — a SvelteKit group-route
	// alias the plugin's resolver does not understand, so `prettier --check .`
	// failed on EVERY file with `Can't resolve '(public)/public-pages.css'` and
	// lint had been permanently red. tokens.css carries the theme (the tokens the
	// plugin actually needs for class sorting) and imports nothing exotic.
	tailwindStylesheet: './src/lib/design/tokens.css'
};

export default config;
