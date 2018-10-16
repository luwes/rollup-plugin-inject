import { attachScopes, createFilter, makeLegalIdentifier } from 'rollup-pluginutils';
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
			{ return parent.computed || node === parent.object; }

		// disregard the `bar` in { bar: foo }
		if (parent.type === 'Property' && node !== parent.value) { return false; }

		// disregard the `bar` in `class Foo { bar () {...} }`
		if (parent.type === 'MethodDefinition') { return false; }

		// disregard the `bar` in `export { foo as bar }`
		if (parent.type === 'ExportSpecifier' && node !== parent.local) { return; }

		return true;
	}
}

function flatten (node) {
	var name;
	var parts = [];

	while (node.type === 'MemberExpression') {
		parts.unshift(node.property.name);
		node = node.object;
	}

	name = node.name;
	parts.unshift(name);

	return { name: name, keypath: parts.join('.') };
}

function inject (options) {
	if (!options) { throw new Error('Missing options'); }

	var filter = createFilter(options.include, options.exclude);

	var modules;

	if (options.modules) {
		modules = options.modules;
	} else {
		modules = Object.assign({}, options);
		delete modules.include;
		delete modules.exclude;
	}

	// Fix paths on Windows
	if (sep !== '/') {
		Object.keys(modules).forEach(function (key) {
			var module = modules[key];

			modules[key] = Array.isArray(module)
				? [module[0].split(sep).join('/'), module[1]]
				: module.split(sep).join('/');
		});
	}

	var firstpass = new RegExp(
		("(?:" + (Object.keys(modules)
			.map(escape)
			.join('|')) + ")"),
		'g'
	);
	var sourceMap = options.sourceMap !== false;

	return {
		name: 'inject',

		transform: function transform (code, id) {
			// Make sure e.g. \u0000rollupPluginBabelHelpers also gets processed.
			// rollup-pluginutils.createFilter filters out \0 prefixed id's.
			id = id.replace('\0', '');

			if (!filter(id)) { return null; }
			if (code.search(firstpass) == -1) { return null; }

			if (sep !== '/') { id = id.split(sep).join('/'); }

			var ast = null;
			try {
				ast = this.parse(code);
			} catch (err) {
				this.warn({
					code: 'PARSE_ERROR',
					message:
						("rollup-plugin-inject: failed to parse " + id + ". Consider restricting the plugin to particular files via options.include")
				});
			}
			if (!ast) { return null; }

			// analyse scopes
			var scope = attachScopes(ast, 'scope');

			var imports = {};
			ast.body.forEach(function (node) {
				if (node.type === 'ImportDeclaration') {
					node.specifiers.forEach(function (specifier) {
						imports[specifier.local.name] = true;
					});
				}
			});

			var magicString = new MagicString(code);

			var newImports = {};

			function handleReference (node, name, keypath) {
				if (keypath in modules && !scope.contains(name) && !imports[name]) {
					var module = modules[keypath];
					if (typeof module === 'string') { module = [module, 'default']; }

					// prevent module from importing itself
					if (module[0] === id) { return; }

					var hash = keypath + ":" + (module[0]) + ":" + (module[1]);

					var importLocalName =
						name === keypath ? name : makeLegalIdentifier(("$inject_" + keypath));

					if (!newImports[hash]) {
						if (module[1] === '*') {
							newImports[hash] = "import * as " + importLocalName + " from '" + (module[0]) + "';";
						} else {
							newImports[hash] = "import { " + (module[1]) + " as " + importLocalName + " } from '" + (module[0]) + "';";
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
				enter: function enter (node, parent) {
					if (sourceMap) {
						magicString.addSourcemapLocation(node.start);
						magicString.addSourcemapLocation(node.end);
					}

					if (node.scope) { scope = node.scope; }

					// special case – shorthand properties. because node.key === node.value,
					// we can't differentiate once we've descended into the node
					if (node.type === 'Property' && node.shorthand) {
						var name = node.key.name;
						handleReference(node, name, name);
						return this.skip();
					}

					if (isReference(node, parent)) {
						var ref = flatten(node);
						var name$1 = ref.name;
						var keypath = ref.keypath;
						var handled = handleReference(node, name$1, keypath);
						if (handled) { return this.skip(); }
					}
				},
				leave: function leave (node) {
					if (node.scope) { scope = scope.parent; }
				}
			});

			var keys = Object.keys(newImports);
			if (!keys.length) { return null; }

			var importBlock = keys.map(function (hash) { return newImports[hash]; }).join('\n\n');
			magicString.prepend(importBlock + '\n\n');

			return {
				code: magicString.toString(),
				map: sourceMap ? magicString.generateMap() : null
			};
		}
	};
}

export default inject;
