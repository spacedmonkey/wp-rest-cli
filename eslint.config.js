// @ts-check
/**
 * WordPress dependencies
 */
import wordpress from '@wordpress/eslint-plugin';

export default [
	...wordpress.configs.recommended,
	{
		// Group imports into External / WordPress / Internal dependency
		// blocks (WordPress/Gutenberg JS coding standard), each preceded by
		// a `@wordpress/dependency-group`-managed JSDoc comment header, and
		// keep every group's imports sorted and separated by a blank line.
		files: [ '**/*.js', '**/*.ts' ],
		rules: {
			'@wordpress/dependency-group': 'error',
			'import/order': [
				'error',
				{
					groups: [
						[ 'builtin', 'external' ],
						'internal',
						[ 'parent', 'sibling', 'index' ],
					],
					pathGroups: [
						{
							pattern: '@wordpress/**',
							group: 'internal',
							position: 'before',
						},
					],
					pathGroupsExcludedImportTypes: [],
					'newlines-between': 'always',
					alphabetize: { order: 'asc', caseInsensitive: true },
				},
			],
		},
	},
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
