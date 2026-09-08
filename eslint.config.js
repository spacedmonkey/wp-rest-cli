// @ts-check
import wordpress from '@wordpress/eslint-plugin';

export default [
	...wordpress.configs.recommended,
	{
		files: [ '**/*.ts' ],
		rules: {
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', ignoreRestSiblings: true },
			],
		},
	},
	{
		// This is a CLI: writing to stdout/stderr is the entire point.
		files: [ 'src/cli.ts', 'src/core/debug.ts' ],
		rules: {
			'no-console': 'off',
		},
	},
	{
		ignores: [ 'dist/**' ],
	},
];
