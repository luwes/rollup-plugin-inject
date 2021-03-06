import {
	attachScopes,
	createFilter,
	makeLegalIdentifier
} from 'rollup-pluginutils';
import { sep } from 'path';
import { walk } from 'estree-walker';

import MagicString from 'magic-string';

function escape (str) {
	return str.replace(/[-[\]/{}()*+?.\\^$|]/g, '\\$&');
}

function isReference (node, parent) {
	if (node.type === 'MemberExpression') {
		return !node.computed && isReference(node.object, node);
	}

	if (node.type === 'Identifier') {
		// TODO is this right?
		if (parent.type === 'MemberExpression')
			return parent.computed || node === parent.object;

		// disregard the `bar` in { bar: foo }
		if (parent.type === 'Property' && node !== parent.value) return false;

		// disregard the `bar` in `class Foo { bar () {...} }`
		if (parent.type === 'MethodDefinition') return false;

		// disregard the `bar` in `export { foo as bar }`
		if (parent.type === 'ExportSpecifier' && node !== parent.local) return;

		return true;
	}
}

function flatten (node) {
	let name;
	let parts = [];

	while (node.type === 'MemberExpression') {
		parts.unshift(node.property.name);
		node = node.object;
	}

	name = node.name;
	parts.unshift(name);

	return { name, keypath: parts.join('.') };
}

export default function inject (options) {
	if (!options) throw new Error('Missing options');

	const filter = createFilter(options.include, options.exclude);

	let modules;

	if (options.modules) {
		modules = options.modules;
	} else {
		modules = Object.assign({}, options);
		delete modules.include;
		delete modules.exclude;
	}

	// Fix paths on Windows
	if (sep !== '/') {
		Object.keys(modules).forEach(key => {
			const module = modules[key];

			modules[key] = Array.isArray(module)
				? [module[0].split(sep).join('/'), module[1]]
				: module.split(sep).join('/');
		});
	}

	const firstpass = new RegExp(
		`(?:${Object.keys(modules)
			.map(escape)
			.join('|')})`,
		'g'
	);
	const sourceMap = options.sourceMap !== false;

	return {
		name: 'inject',

		transform (code, id) {
			// Make sure e.g. \u0000rollupPluginBabelHelpers also gets processed.
			// rollup-pluginutils.createFilter filters out \0 prefixed id's.
			id = id.replace('\0', '');

			if (!filter(id)) return null;
			if (code.search(firstpass) == -1) return null;

			if (sep !== '/') id = id.split(sep).join('/');

			let ast = null;
			try {
				ast = this.parse(code);
			} catch (err) {
				this.warn({
					code: 'PARSE_ERROR',
					message:
						`rollup-plugin-inject: failed to parse ${id}. Consider restricting the plugin to particular files via options.include`
				});
			}
			if (!ast) return null;

			// analyse scopes
			let scope = attachScopes(ast, 'scope');

			let imports = {};
			ast.body.forEach(node => {
				if (node.type === 'ImportDeclaration') {
					node.specifiers.forEach(specifier => {
						imports[specifier.local.name] = true;
					});
				}
			});

			const magicString = new MagicString(code);

			let newImports = {};

			function handleReference (node, name, keypath) {
				if (keypath in modules && !scope.contains(name) && !imports[name]) {
					let module = modules[keypath];
					if (typeof module === 'string') module = [module, 'default'];

					// prevent module from importing itself
					if (module[0] === id) return;

					const hash = `${keypath}:${module[0]}:${module[1]}`;

					const importLocalName =
						name === keypath ? name : makeLegalIdentifier(`$inject_${keypath}`);

					if (!newImports[hash]) {
						if (module[1] === '*') {
							newImports[hash] = `import * as ${importLocalName} from '${
								module[0]
							}';`;
						} else {
							newImports[hash] = `import { ${
								module[1]
							} as ${importLocalName} } from '${module[0]}';`;
						}
					}

					if (name !== keypath) {
						magicString.overwrite(node.start, node.end, importLocalName, {
							storeName: true
						});
					}

					return true;
				}
			}

			walk(ast, {
				enter (node, parent) {
					if (sourceMap) {
						magicString.addSourcemapLocation(node.start);
						magicString.addSourcemapLocation(node.end);
					}

					if (node.scope) scope = node.scope;

					// special case – shorthand properties. because node.key === node.value,
					// we can't differentiate once we've descended into the node
					if (node.type === 'Property' && node.shorthand) {
						const name = node.key.name;
						handleReference(node, name, name);
						return this.skip();
					}

					if (isReference(node, parent)) {
						const { name, keypath } = flatten(node);
						const handled = handleReference(node, name, keypath);
						if (handled) return this.skip();
					}
				},
				leave (node) {
					if (node.scope) scope = scope.parent;
				}
			});

			const keys = Object.keys(newImports);
			if (!keys.length) return null;

			const importBlock = keys.map(hash => newImports[hash]).join('\n\n');
			magicString.prepend(importBlock + '\n\n');

			return {
				code: magicString.toString(),
				map: sourceMap ? magicString.generateMap() : null
			};
		}
	};
}
