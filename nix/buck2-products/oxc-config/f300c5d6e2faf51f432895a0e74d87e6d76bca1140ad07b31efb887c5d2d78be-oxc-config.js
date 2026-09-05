// src/explicit-boolean-compare.ts
var COMPARISON_OPERATORS = new Set([
  "===",
  "!==",
  "==",
  "!=",
  "<",
  ">",
  "<=",
  ">=",
  "instanceof",
  "in"
]);
var KNOWN_BOOLEAN_METHODS = new Set([
  "includes",
  "startsWith",
  "endsWith",
  "test",
  "has",
  "every",
  "some"
]);
var isBooleanNamingConvention = (name) => /^(is|has)[A-Z]/.test(name);
var isKnownBooleanExpression = (node) => {
  if (node.type !== "CallExpression")
    return false;
  const callee = node.callee;
  if (callee.type === "MemberExpression" && callee.property?.name !== undefined) {
    const name = callee.property.name;
    if (KNOWN_BOOLEAN_METHODS.has(name) === true)
      return true;
    if (isBooleanNamingConvention(name) === true)
      return true;
  }
  if (callee.type === "Identifier" && isBooleanNamingConvention(callee.name) === true)
    return true;
  return false;
};
var isExplicit = (node) => {
  if (node === undefined || node === null)
    return true;
  if (node.type === "BinaryExpression" && COMPARISON_OPERATORS.has(node.operator) === true)
    return true;
  if (node.type === "Literal" && typeof node.value === "boolean")
    return true;
  return false;
};
var collectImplicit = (node) => {
  if (node === undefined || node === null)
    return [];
  if (isExplicit(node) === true)
    return [];
  if (node.type === "LogicalExpression" && (node.operator === "&&" || node.operator === "||")) {
    return [...collectImplicit(node.left), ...collectImplicit(node.right)];
  }
  if (node.type === "UnaryExpression" && node.operator === "!") {
    if (isExplicit(node.argument) === true)
      return [];
    if (node.argument.type === "LogicalExpression" && (node.argument.operator === "&&" || node.argument.operator === "||")) {
      return collectImplicit(node.argument);
    }
    return [node];
  }
  if (node.type === "MemberExpression" && node.property?.name === "main" && node.object?.type === "MetaProperty") {
    return [];
  }
  return [node];
};
var explicitBooleanCompareRule = {
  meta: {
    type: "suggestion",
    fixable: "code",
    docs: {
      description: "Enforce explicit boolean-literal comparisons in condition positions (if, while, for, ternary)",
      recommended: false
    },
    messages: {
      implicitBooleanCondition: "Avoid implicit boolean coercion. Use an explicit comparison (e.g. `=== true`, `=== false`, `!== null`)."
    },
    schema: []
  },
  defaultOptions: [],
  create(context) {
    const makeFix = (node) => {
      if (node.type === "UnaryExpression" && node.operator === "!") {
        if (isKnownBooleanExpression(node.argument) === false)
          return;
        return (fixer) => {
          const argText = context.sourceCode.getText(node.argument);
          return fixer.replaceText(node, `${argText} === false`);
        };
      }
      if (isKnownBooleanExpression(node) === false)
        return;
      return (fixer) => {
        const text = context.sourceCode.getText(node);
        return fixer.replaceText(node, `${text} === true`);
      };
    };
    const checkTest = (test) => {
      if (test === undefined || test === null)
        return;
      for (const node of collectImplicit(test)) {
        context.report({
          node,
          messageId: "implicitBooleanCondition",
          fix: makeFix(node)
        });
      }
    };
    return {
      IfStatement(node) {
        checkTest(node.test);
      },
      WhileStatement(node) {
        checkTest(node.test);
      },
      DoWhileStatement(node) {
        checkTest(node.test);
      },
      ForStatement(node) {
        checkTest(node.test);
      },
      ConditionalExpression(node) {
        checkTest(node.test);
      }
    };
  }
};

// src/exports-first.ts
var isTrackableDeclaration = (node) => {
  const type = node.type;
  return type === "VariableDeclaration" || type === "FunctionDeclaration" || type === "ClassDeclaration" || type === "TSEnumDeclaration";
};
var isExportDeclaration = (node) => node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration";
var isReExport = (node) => node.type === "ExportNamedDeclaration" && node.source !== null;
var isTypeOnlyExport = (node) => {
  if (node.type === "ExportNamedDeclaration") {
    return node.exportKind === "type";
  }
  return false;
};
var getDeclaredNames = (node) => {
  const names = new Set;
  if (node.type === "VariableDeclaration") {
    for (const decl of node.declarations) {
      if (decl.id.type === "Identifier") {
        names.add(decl.id.name);
      } else if (decl.id.type === "ObjectPattern") {
        for (const prop of decl.id.properties) {
          if (prop.type === "Property" && prop.value.type === "Identifier") {
            names.add(prop.value.name);
          } else if (prop.type === "RestElement" && prop.argument.type === "Identifier") {
            names.add(prop.argument.name);
          }
        }
      } else if (decl.id.type === "ArrayPattern") {
        for (const elem of decl.id.elements) {
          if (elem?.type === "Identifier") {
            names.add(elem.name);
          }
        }
      }
    }
  } else if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration" || node.type === "TSEnumDeclaration") {
    if (node.id?.name !== undefined) {
      names.add(node.id.name);
    }
  }
  return names;
};
var collectReferences = (opts) => {
  const { node } = opts;
  const refs = opts.refs ?? new Set;
  if (node === undefined || node === null || typeof node !== "object")
    return refs;
  if (node.type === "Identifier") {
    refs.add(node.name);
    return refs;
  }
  for (const key of Object.keys(node)) {
    if (key === "parent" || key === "loc" || key === "range")
      continue;
    const value = node[key];
    if (Array.isArray(value) === true) {
      for (const item of value) {
        collectReferences({ node: item, refs });
      }
    } else if (value !== undefined && value !== null && typeof value === "object") {
      collectReferences({ node: value, refs });
    }
  }
  return refs;
};
var getExportDeclaration = (node) => {
  if (node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration") {
    return node.declaration;
  }
  return null;
};
var exportsFirstRule = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Enforce exported declarations come before non-exported declarations",
      recommended: false
    },
    messages: {
      exportAfterNonExport: "Exported declaration should come before non-exported declarations. Move this export above non-exported code."
    },
    schema: []
  },
  defaultOptions: [],
  create(context) {
    return {
      Program(programNode) {
        let hasExport = false;
        let hasTrackableNonExport = false;
        let exportAfterNonExport = false;
        for (const node of programNode.body) {
          if (node.type === "ImportDeclaration") {
            continue;
          }
          if (isReExport(node) === true) {
            continue;
          }
          if (isTypeOnlyExport(node) === true) {
            continue;
          }
          if (isExportDeclaration(node) === true) {
            hasExport = true;
            if (hasTrackableNonExport === true) {
              exportAfterNonExport = true;
              break;
            }
            continue;
          }
          if (isTrackableDeclaration(node) === true) {
            hasTrackableNonExport = true;
          }
        }
        if (hasExport === false || hasTrackableNonExport === false || exportAfterNonExport === false) {
          return;
        }
        const nonExportedDecls = [];
        const exports = [];
        for (let i = 0;i < programNode.body.length; i++) {
          const node = programNode.body[i];
          if (node.type === "ImportDeclaration")
            continue;
          if (isReExport(node) === true)
            continue;
          if (isTypeOnlyExport(node) === true)
            continue;
          if (isExportDeclaration(node) === true) {
            const decl = getExportDeclaration(node);
            const refs = decl !== undefined ? collectReferences({ node: decl }) : new Set;
            exports.push({ node, index: i, refs });
          } else if (isTrackableDeclaration(node) === true) {
            const names = getDeclaredNames(node);
            nonExportedDecls.push({ names, node, index: i });
          }
        }
        const referencedByAnyExport = new Set;
        for (const exp of exports) {
          for (const ref of exp.refs) {
            referencedByAnyExport.add(ref);
          }
        }
        let changed = true;
        while (changed === true) {
          changed = false;
          for (const decl of nonExportedDecls) {
            let isNeeded = false;
            for (const name of decl.names) {
              if (referencedByAnyExport.has(name) === true) {
                isNeeded = true;
                break;
              }
            }
            if (isNeeded === true) {
              const declRefs = collectReferences({ node: decl.node });
              for (const ref of declRefs) {
                if (referencedByAnyExport.has(ref) === false) {
                  referencedByAnyExport.add(ref);
                  changed = true;
                }
              }
            }
          }
        }
        for (const exp of exports) {
          for (const decl of nonExportedDecls) {
            if (decl.index < exp.index) {
              let isReferenced = false;
              for (const name of decl.names) {
                if (referencedByAnyExport.has(name) === true) {
                  isReferenced = true;
                  break;
                }
              }
              if (isReferenced === false) {
                context.report({
                  node: exp.node,
                  messageId: "exportAfterNonExport"
                });
                break;
              }
            }
          }
        }
      }
    };
  }
};

// src/jsdoc-require-exports.ts
var hasJsDocComment = ({
  node,
  sourceCode
}) => {
  const comments = sourceCode.getCommentsBefore(node);
  const nodeStartLine = node.loc?.start.line;
  if (nodeStartLine === undefined)
    return false;
  const sortedComments = [...comments].filter((c) => c.loc?.end.line !== undefined).toSorted((a, b) => b.loc.end.line - a.loc.end.line);
  const lineCommentLines = new Set;
  for (const comment of sortedComments) {
    if (comment.type === "Line" && comment.loc?.start.line !== undefined) {
      lineCommentLines.add(comment.loc.start.line);
    }
  }
  for (const comment of sortedComments) {
    if (comment.type === "Block" && comment.value.startsWith("*") === true) {
      const commentEndLine = comment.loc?.end.line;
      if (commentEndLine === undefined)
        continue;
      let isAdjacent = true;
      for (let line = commentEndLine + 1;line < nodeStartLine; line++) {
        if (lineCommentLines.has(line) === false) {
          isAdjacent = false;
          break;
        }
      }
      if (isAdjacent === true) {
        return true;
      }
    }
  }
  return false;
};
var isDerivedTypeofAlias = (decl) => {
  if (decl?.type !== "TSTypeAliasDeclaration")
    return false;
  const typeAnnotation = decl.typeAnnotation;
  return typeAnnotation?.type === "TSTypeQuery";
};
var isExportRequiringJsDoc = (node) => {
  if (node.type === "ExportNamedDeclaration") {
    const n = node;
    const decl = n.declaration;
    if (decl === undefined || decl === null)
      return false;
    if (decl.type === "TSTypeAliasDeclaration" && isDerivedTypeofAlias(decl) === true) {
      return false;
    }
    if (decl.type === "TSInterfaceDeclaration")
      return true;
    if (decl.type === "TSTypeAliasDeclaration")
      return true;
    if (decl.type === "VariableDeclaration")
      return true;
    if (decl.type === "FunctionDeclaration")
      return true;
    if (decl.type === "ClassDeclaration")
      return true;
  }
  return false;
};
var getExportDescription = (node) => {
  if (node.type === "ExportAllDeclaration") {
    return `* from '${node.source.value}'`;
  }
  if (node.type === "ExportNamedDeclaration") {
    const n = node;
    const decl = n.declaration;
    if (decl?.type === "TSInterfaceDeclaration") {
      return `interface ${decl.id.name}`;
    }
    if (decl?.type === "TSTypeAliasDeclaration") {
      return `type ${decl.id.name}`;
    }
    if (decl?.type === "VariableDeclaration") {
      const names = decl.declarations.map((d) => d.id?.name ?? "unknown").join(", ");
      return `const ${names}`;
    }
    if (decl?.type === "FunctionDeclaration") {
      return `function ${decl.id?.name ?? "unknown"}`;
    }
    if (decl?.type === "ClassDeclaration") {
      return `class ${decl.id?.name ?? "unknown"}`;
    }
  }
  return "export";
};
var jsdocRequireExportsRule = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Require JSDoc comments on exported declarations",
      recommended: false
    },
    messages: {
      missingJsdoc: "Missing JSDoc comment for exported '{{name}}'."
    },
    schema: []
  },
  defaultOptions: [],
  create(context) {
    const { sourceCode } = context;
    const functionOverloads = new Set;
    return {
      ExportAllDeclaration(node) {
        const n = node;
        if (n.exported === undefined || n.exported === null)
          return;
        if (hasJsDocComment({ node, sourceCode }) === false) {
          context.report({
            node,
            messageId: "missingJsdoc",
            data: { name: getExportDescription(node) }
          });
        }
      },
      ExportNamedDeclaration(node) {
        const n = node;
        const decl = n.declaration;
        if (decl?.type === "TSDeclareFunction") {
          const funcName = decl.id?.name;
          if (funcName !== undefined) {
            if (functionOverloads.has(funcName) === false) {
              functionOverloads.add(funcName);
              if (hasJsDocComment({ node, sourceCode }) === false) {
                context.report({
                  node,
                  messageId: "missingJsdoc",
                  data: { name: `function ${funcName}` }
                });
              }
            }
          }
          return;
        }
        if (isExportRequiringJsDoc(node) === false)
          return;
        if (decl?.type === "FunctionDeclaration") {
          const funcName = decl.id?.name;
          if (funcName !== undefined && functionOverloads.has(funcName) === true) {
            return;
          }
        }
        if (hasJsDocComment({ node, sourceCode }) === false) {
          context.report({
            node,
            messageId: "missingJsdoc",
            data: { name: getExportDescription(node) }
          });
        }
      }
    };
  }
};

// src/named-args.ts
var countNonRestParams = (params) => {
  if (params.length === 0)
    return 0;
  const lastParam = params[params.length - 1];
  if (lastParam.type === "RestElement") {
    return params.length - 1;
  }
  return params.length;
};
var isCallback = (node) => {
  const parent = node.parent;
  if (parent === undefined)
    return false;
  if (parent.type === "CallExpression") {
    if (parent.arguments.includes(node) === true)
      return true;
    if (parent.callee === node)
      return true;
  }
  if (parent.type === "NewExpression") {
    return parent.arguments.includes(node);
  }
  if (parent.type === "Property" && parent.value === node) {
    const objectExpr = parent.parent;
    if (objectExpr?.type === "ObjectExpression") {
      const grandparent = objectExpr.parent;
      if (grandparent?.type === "CallExpression" && grandparent.arguments.includes(objectExpr) === true) {
        return true;
      }
      if (grandparent?.type === "NewExpression" && grandparent.arguments.includes(objectExpr) === true) {
        return true;
      }
    }
  }
  return false;
};
var isEffectGenAdapter = (node) => {
  if (node.type !== "FunctionExpression" || node.generator === false)
    return false;
  if (node.params.length !== 1)
    return false;
  const param = node.params[0];
  if (param.type !== "Identifier" || param.name !== "_")
    return false;
  const parent = node.parent;
  if (parent?.type !== "CallExpression")
    return false;
  const callee = parent.callee;
  if (callee?.type !== "MemberExpression")
    return false;
  if (callee.property?.name !== "gen")
    return false;
  return true;
};
var isEffectDualFunction = (node) => {
  const parent = node.parent;
  if (parent?.type !== "CallExpression")
    return false;
  const args = parent.arguments;
  if (args.length < 2)
    return false;
  if (args[1] !== node)
    return false;
  const callee = parent.callee;
  if (callee?.type === "MemberExpression") {
    const property = callee.property;
    if (property?.type === "Identifier" && property.name === "dual") {
      const obj = callee.object;
      if (obj?.type === "Identifier") {
        if (["F", "Function", "Fn"].includes(obj.name) === true)
          return true;
      }
    }
  }
  if (callee?.type === "Identifier" && callee.name === "dual") {
    return true;
  }
  return false;
};
var getFunctionContext = (node) => {
  if (node.type === "FunctionDeclaration" && node.id?.name !== undefined) {
    return `function '${node.id.name}'`;
  }
  const parent = node.parent;
  if (parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier") {
    return `function '${parent.id.name}'`;
  }
  if (parent?.type === "Property" && parent.key?.type === "Identifier") {
    return `method '${parent.key.name}'`;
  }
  if (parent?.type === "MethodDefinition" && parent.key?.type === "Identifier") {
    return `method '${parent.key.name}'`;
  }
  return "function";
};
var namedArgsRule = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Enforce functions use named arguments (options objects) instead of positional parameters",
      recommended: false
    },
    messages: {
      tooManyParams: "{{context}} has {{count}} parameters. Consider using named arguments: ({ param1, param2 }) => ..."
    },
    schema: []
  },
  defaultOptions: [],
  create(context) {
    const checkFunction = (node) => {
      if (isCallback(node) === true)
        return;
      if (isEffectGenAdapter(node) === true)
        return;
      if (isEffectDualFunction(node) === true)
        return;
      const nonRestCount = countNonRestParams(node.params);
      if (nonRestCount <= 1)
        return;
      context.report({
        node,
        messageId: "tooManyParams",
        data: {
          context: getFunctionContext(node),
          count: nonRestCount
        }
      });
    };
    return {
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction
    };
  }
};

// src/no-external-imports.ts
var isExternalSpecifier = (source) => !source.startsWith(".") && !source.startsWith("node:");
var isTypeOnlyImport = (node) => {
  if (node.importKind === "type")
    return true;
  const specifiers = node.specifiers;
  if (Array.isArray(specifiers) === false || specifiers.length === 0)
    return false;
  return specifiers.every((s) => s.importKind === "type");
};
var isTypeOnlyExport2 = (node) => {
  if (node.exportKind === "type")
    return true;
  const specifiers = node.specifiers;
  if (Array.isArray(specifiers) === false || specifiers.length === 0)
    return false;
  return specifiers.every((s) => s.exportKind === "type");
};
var noExternalImportsRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow value imports and re-exports from npm packages (type-only imports are allowed)",
      recommended: false
    },
    messages: {
      noExternalImport: 'Value import from "{{source}}" is not allowed. This module must be dependency-free. Use `import type` for type-only imports, or move the code to a module that allows dependencies.',
      noExternalExport: 'Value re-export from "{{source}}" is not allowed. This module must be dependency-free. Use `export type` for type-only re-exports, or move the code to a module that allows dependencies.'
    },
    schema: []
  },
  defaultOptions: [],
  create(context) {
    return {
      ImportDeclaration(node) {
        if (isTypeOnlyImport(node) === true)
          return;
        const source = node.source?.value;
        if (typeof source !== "string")
          return;
        if (isExternalSpecifier(source) === true) {
          context.report({
            node,
            messageId: "noExternalImport",
            data: { source }
          });
        }
      },
      ExportNamedDeclaration(node) {
        if (node.source === undefined)
          return;
        if (isTypeOnlyExport2(node) === true)
          return;
        const source = node.source?.value;
        if (typeof source !== "string")
          return;
        if (isExternalSpecifier(source) === true) {
          context.report({
            node,
            messageId: "noExternalExport",
            data: { source }
          });
        }
      },
      ExportAllDeclaration(node) {
        if (node.exportKind === "type")
          return;
        const source = node.source?.value;
        if (typeof source !== "string")
          return;
        if (isExternalSpecifier(source) === true) {
          context.report({
            node,
            messageId: "noExternalExport",
            data: { source }
          });
        }
      }
    };
  }
};

// src/no-non-durable-wait.ts
var callExpressionSource = (node) => {
  const callee = node.callee;
  if (callee?.type !== "MemberExpression")
    return;
  if (callee.computed === true)
    return;
  const object = callee.object;
  if (object?.type !== "Identifier" || object.name !== "Effect")
    return;
  const propertyName = callee.property?.name;
  if (propertyName === "sleep")
    return "Effect.sleep()";
  if (propertyName === "timeout")
    return "Effect.timeout()";
  return;
};
var isInsideRestateRun = (node) => {
  let current = node;
  let parent = current.parent;
  while (parent !== undefined && parent !== null) {
    if (parent.type === "CallExpression" && isRestateRunCallee(parent.callee) === true && parent.arguments.includes(current) === true) {
      return true;
    }
    current = parent;
    parent = current.parent;
  }
  return false;
};
var isRestateRunCallee = (callee) => callee?.type === "MemberExpression" && callee.computed === false && callee.property?.type === "Identifier" && callee.property.name === "run";
var noNonDurableWaitRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Ban non-durable Effect.sleep/Effect.timeout outside a journaled Restate.run closure (use Restate.sleep/Restate.timeout for durable waits)",
      recommended: false
    },
    messages: {
      nonDurableWait: "Non-durable `{{source}}` schedules an in-process timer that does not survive suspension/replay. Use `Restate.sleep`/`Restate.timeout` for a durable wait, or move it inside a journaled `Restate.run(...)` step."
    },
    schema: []
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        const source = callExpressionSource(node);
        if (source === undefined)
          return;
        if (isInsideRestateRun(node) === true)
          return;
        context.report({
          node,
          messageId: "nonDurableWait",
          data: { source }
        });
      }
    };
  }
};

// src/no-raw-nondeterminism.ts
var callExpressionSource2 = (node) => {
  const callee = node.callee;
  if (callee?.type !== "MemberExpression")
    return;
  if (callee.computed === true)
    return;
  const propertyName = callee.property?.name;
  const object = callee.object;
  if (object?.type === "Identifier" && object.name === "Date" && propertyName === "now") {
    return "Date.now()";
  }
  if (object?.type === "Identifier" && object.name === "Math" && propertyName === "random") {
    return "Math.random()";
  }
  if (propertyName === "randomUUID" && isCryptoObject(object) === true) {
    return "crypto.randomUUID()";
  }
  return;
};
var isCryptoObject = (object) => {
  if (object?.type === "Identifier" && object.name === "crypto")
    return true;
  if (object?.type === "MemberExpression" && object.computed === false && object.object?.type === "Identifier" && object.object.name === "globalThis" && object.property?.name === "crypto") {
    return true;
  }
  return false;
};
var isArglessNewDate = (node) => {
  if (node.callee?.type !== "Identifier" || node.callee.name !== "Date")
    return false;
  return node.arguments.length === 0;
};
var isInsideRestateRun2 = (node) => {
  let current = node;
  let parent = current.parent;
  while (parent !== undefined && parent !== null) {
    if (parent.type === "CallExpression" && isRestateRunCallee2(parent.callee) === true && parent.arguments.includes(current) === true) {
      return true;
    }
    current = parent;
    parent = current.parent;
  }
  return false;
};
var isRestateRunCallee2 = (callee) => callee?.type === "MemberExpression" && callee.computed === false && callee.property?.type === "Identifier" && callee.property.name === "run";
var noRawNondeterminismRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Ban raw nondeterminism (Date.now, new Date, Math.random, crypto.randomUUID) outside a journaled Restate.run closure",
      recommended: false
    },
    messages: {
      rawNondeterminism: "Raw nondeterminism `{{source}}` breaks Restate deterministic replay. Use the journaled `Clock`/`Random` (backed by `ctx.date`/`ctx.rand`), or wrap it in `Restate.run(...)` so its result is journaled."
    },
    schema: []
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        const source = callExpressionSource2(node);
        if (source === undefined)
          return;
        if (isInsideRestateRun2(node) === true)
          return;
        context.report({
          node,
          messageId: "rawNondeterminism",
          data: { source }
        });
      },
      NewExpression(node) {
        if (isArglessNewDate(node) === false)
          return;
        if (isInsideRestateRun2(node) === true)
          return;
        context.report({
          node,
          messageId: "rawNondeterminism",
          data: { source: "new Date()" }
        });
      }
    };
  }
};

// src/no-raw-otel-primitives.ts
var rawEffectMembers = new Set(["withSpan", "annotateCurrentSpan"]);
var rawStreamMembers = new Set(["withSpan"]);
var rawMetricMembers = new Set([
  "counter",
  "histogram",
  "tagged",
  "increment",
  "incrementBy",
  "update"
]);
var createTracker = () => ({
  effectNamespaces: new Set,
  streamNamespaces: new Set,
  metricNamespaces: new Set,
  effectModuleNamespaces: new Set,
  directRawCalls: new Set
});
var trackEffectImport = ({
  tracker,
  node
}) => {
  if (node.source?.value !== "effect")
    return;
  for (const specifier of node.specifiers ?? []) {
    if (specifier.importKind === "type")
      continue;
    if (specifier.type === "ImportNamespaceSpecifier") {
      const localName2 = specifier.local?.name;
      if (typeof localName2 === "string")
        tracker.effectModuleNamespaces.add(localName2);
      continue;
    }
    if (specifier.type !== "ImportSpecifier")
      continue;
    const importedName = importSpecifierImportedName(specifier);
    const localName = specifier.local?.name;
    if (typeof importedName !== "string" || typeof localName !== "string")
      continue;
    if (importedName === "Effect")
      tracker.effectNamespaces.add(localName);
    if (importedName === "Stream")
      tracker.streamNamespaces.add(localName);
    if (importedName === "Metric")
      tracker.metricNamespaces.add(localName);
    if (rawEffectMembers.has(importedName) === true || rawStreamMembers.has(importedName) === true || rawMetricMembers.has(importedName) === true) {
      tracker.directRawCalls.add(localName);
    }
  }
};
var importSpecifierImportedName = (specifier) => {
  const imported = specifier.imported;
  if (imported?.type === "Identifier")
    return imported.name;
  if (imported?.type === "Literal" && typeof imported.value === "string")
    return imported.value;
  return;
};
var rawOtelCallSource = ({
  tracker,
  node
}) => {
  const callee = node.callee;
  if (callee?.type === "Identifier" && tracker.directRawCalls.has(callee.name) === true) {
    if (callee.name === "annotateCurrentSpan")
      return "Effect.annotateCurrentSpan()";
    if (rawMetricMembers.has(callee.name) === true)
      return `Metric.${callee.name}()`;
    return "Effect.withSpan() / Stream.withSpan()";
  }
  if (callee?.type !== "MemberExpression" || callee.computed === true)
    return;
  const propertyName = callee.property?.name;
  if (typeof propertyName !== "string")
    return;
  const object = callee.object;
  if (object?.type === "Identifier") {
    if (tracker.effectNamespaces.has(object.name) === true && rawEffectMembers.has(propertyName) === true) {
      return `Effect.${propertyName}()`;
    }
    if (tracker.streamNamespaces.has(object.name) === true && rawStreamMembers.has(propertyName) === true) {
      return `Stream.${propertyName}()`;
    }
    if (tracker.metricNamespaces.has(object.name) === true && rawMetricMembers.has(propertyName) === true) {
      return `Metric.${propertyName}()`;
    }
  }
  const namespaceCall = rawOtelNamespaceCallSource({ tracker, callee });
  if (namespaceCall !== undefined)
    return namespaceCall;
  return;
};
var rawOtelNamespaceCallSource = ({
  tracker,
  callee
}) => {
  const namespaceMember = callee.object;
  if (namespaceMember?.type !== "MemberExpression" || namespaceMember.computed === true) {
    return;
  }
  const root = namespaceMember.object;
  if (root?.type !== "Identifier")
    return;
  if (tracker.effectModuleNamespaces.has(root.name) === false)
    return;
  const namespaceName = namespaceMember.property?.name;
  const propertyName = callee.property?.name;
  if (namespaceName === "Effect" && rawEffectMembers.has(propertyName) === true) {
    return `Effect.${propertyName}()`;
  }
  if (namespaceName === "Stream" && rawStreamMembers.has(propertyName) === true) {
    return `Stream.${propertyName}()`;
  }
  if (namespaceName === "Metric" && rawMetricMembers.has(propertyName) === true) {
    return `Metric.${propertyName}()`;
  }
  return;
};
var noRawOtelPrimitivesRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Ban raw Effect/Stream/Metric OpenTelemetry primitives outside schema-backed OTEL contract boundaries",
      recommended: false
    },
    messages: {
      rawOtelPrimitive: "Raw OTEL primitive `{{source}}` bypasses the schema-first telemetry contract. Define an `OtelOperation`/`OtelSpan`/`OtelMetric` contract in package observability code and use that instead."
    },
    schema: []
  },
  defaultOptions: [],
  create(context) {
    const tracker = createTracker();
    return {
      ImportDeclaration(node) {
        trackEffectImport({ tracker, node });
      },
      CallExpression(node) {
        const source = rawOtelCallSource({ tracker, node });
        if (source === undefined)
          return;
        context.report({
          node,
          messageId: "rawOtelPrimitive",
          data: { source }
        });
      }
    };
  }
};

// src/otel-contract-in-seam-file.ts
var REGISTRY_MODULE = "@overeng/otel-contract/registry";
var DIRECT_CONSTRUCTORS = new Set(["defineOtelContract", "span", "metric", "operation"]);
var ATTR_BUILDER = "attr";
var createTracker2 = () => ({ directCalls: new Set, attrObjects: new Set });
var importedName = (specifier) => {
  const imported = specifier.imported;
  if (imported?.type === "Identifier")
    return imported.name;
  if (imported?.type === "Literal" && typeof imported.value === "string")
    return imported.value;
  return;
};
var trackRegistryImport = ({
  tracker,
  node
}) => {
  if (node.source?.value !== REGISTRY_MODULE)
    return;
  for (const specifier of node.specifiers ?? []) {
    if (specifier.importKind === "type")
      continue;
    if (specifier.type !== "ImportSpecifier")
      continue;
    const name = importedName(specifier);
    const local = specifier.local?.name;
    if (typeof name !== "string" || typeof local !== "string")
      continue;
    if (DIRECT_CONSTRUCTORS.has(name) === true)
      tracker.directCalls.add(local);
    if (name === ATTR_BUILDER)
      tracker.attrObjects.add(local);
  }
};
var contractCallSource = ({
  tracker,
  node
}) => {
  const callee = node.callee;
  if (callee?.type === "Identifier" && tracker.directCalls.has(callee.name) === true) {
    return `${callee.name}()`;
  }
  if (callee?.type === "MemberExpression" && callee.computed !== true) {
    const object = callee.object;
    const property = callee.property?.name;
    if (object?.type === "Identifier" && tracker.attrObjects.has(object.name) === true && typeof property === "string") {
      return `${object.name}.${property}()`;
    }
  }
  return;
};
var isSeamFile = (filename) => filename.endsWith(".contract.ts");
var otelContractInSeamFileRule = {
  meta: {
    type: "problem",
    docs: {
      description: "OTel semantic-convention contract constructors must be authored in a `*.contract.ts` seam file so they are discoverable by construction (decision 0005)",
      recommended: false
    },
    messages: {
      contractOutsideSeam: "Contract constructor `{{source}}` from `@overeng/otel-contract/registry` must live in a `*.contract.ts` seam file so it is discoverable by the registry projection + conformance sweep. Move this contract into the package’s seam file."
    },
    schema: []
  },
  defaultOptions: [],
  create(context) {
    const filename = context.filename ?? context.getFilename?.() ?? "";
    if (isSeamFile(filename) === true)
      return {};
    const tracker = createTracker2();
    return {
      ImportDeclaration(node) {
        trackRegistryImport({ tracker, node });
      },
      CallExpression(node) {
        const source = contractCallSource({ tracker, node });
        if (source === undefined)
          return;
        context.report({ node, messageId: "contractOutsideSeam", data: { source } });
      }
    };
  }
};

// src/storybook/utils.ts
var findTopLevelConstInit = (opts) => {
  const { program, name } = opts;
  if (program === undefined || program === null)
    return null;
  for (const stmt of program.body) {
    if (stmt.type !== "VariableDeclaration")
      continue;
    for (const decl of stmt.declarations) {
      if (decl.id?.type === "Identifier" && decl.id.name === name) {
        return decl.init ?? null;
      }
    }
  }
  return null;
};
var getMetaObjectExpression = (opts) => {
  const { node, program } = opts;
  let meta = node.declaration;
  if (meta?.type === "Identifier") {
    meta = findTopLevelConstInit({ program, name: meta.name });
  }
  if (meta?.type === "TSAsExpression" || meta?.type === "TSSatisfiesExpression") {
    meta = meta.expression;
  }
  return meta?.type === "ObjectExpression" ? meta : null;
};
var getDescriptor = (opts) => {
  const { meta, propertyName } = opts;
  const property = meta?.properties?.find((p) => ("key" in p) && p.key !== undefined && ("name" in p.key) && p.key.name === propertyName);
  if (property === undefined || property.type === "SpreadElement") {
    return;
  }
  const value = property.value;
  if (value.type === "ArrayExpression") {
    return value.elements.map((el) => el?.value);
  }
  if (value.type === "Literal") {
    return value.value;
  }
  return;
};
var isExportStory = (opts) => {
  const { key, config } = opts;
  const { includeStories, excludeStories } = config;
  const matches = (descriptor) => {
    if (Array.isArray(descriptor) === true)
      return descriptor.includes(key);
    return descriptor.test(key);
  };
  return key !== "__esModule" && (includeStories === undefined || matches(includeStories)) && (excludeStories === undefined || matches(excludeStories) === false);
};
var isValidStoryExport = (opts) => {
  const { name, config } = opts;
  return isExportStory({ key: name, config }) === true && name !== "__namedExportsOrder";
};
var storyNameFromExport = (key) => key.replace(/_/g, " ").replace(/-/g, " ").replace(/\./g, " ").replace(/([^\n])([A-Z])([a-z])/g, (_m, $1, $2, $3) => `${$1} ${$2}${$3}`).replace(/([a-z])([A-Z])/g, (_m, $1, $2) => `${$1} ${$2}`).replace(/([a-z])([0-9])/gi, (_m, $1, $2) => `${$1} ${$2}`).replace(/([0-9])([a-z])/gi, (_m, $1, $2) => `${$1} ${$2}`).replace(/(\s|^)(\w)/g, (_m, $1, $2) => `${$1}${$2.toUpperCase()}`).replace(/ +/g, " ").trim();
var getAllNamedExports = (node) => {
  if ((node.declaration === null || node.declaration === undefined) && node.specifiers !== undefined && node.specifiers !== null) {
    const acc = [];
    for (const specifier of node.specifiers) {
      if (specifier.exported?.type === "Identifier")
        acc.push(specifier.exported);
    }
    return acc;
  }
  const decl = node.declaration;
  if (decl?.type === "VariableDeclaration") {
    const declaration = decl.declarations[0];
    if (declaration?.id?.type === "Identifier")
      return [declaration.id];
  }
  if (decl?.type === "FunctionDeclaration" && decl.id?.type === "Identifier") {
    return [decl.id];
  }
  return [];
};
var isStoriesOfImportSpecifier = (node) => node.imported !== undefined && ("name" in node.imported) && node.imported.name === "storiesOf";

// src/storybook/csf-component.ts
var csfComponentRule = {
  meta: {
    type: "suggestion",
    docs: {
      description: "The component property should be set in the CSF Meta object",
      recommended: false
    },
    messages: {
      missingComponentProperty: "Missing component property."
    },
    schema: []
  },
  defaultOptions: [],
  create(context) {
    let program = null;
    return {
      Program(node) {
        program = node;
      },
      ExportDefaultDeclaration(node) {
        const meta = getMetaObjectExpression({ node, program });
        if (meta === null)
          return;
        const componentProperty = meta.properties.find((property) => property.type !== "SpreadElement" && property.key !== undefined && ("name" in property.key) && property.key.name === "component");
        if (componentProperty === undefined) {
          context.report({ node, messageId: "missingComponentProperty" });
        }
      }
    };
  }
};

// src/storybook/default-exports.ts
var isCsf4MetaDeclaration = (node) => {
  if (node.parent?.type !== "Program")
    return false;
  for (const declaration of node.declarations) {
    const init = declaration.init;
    if (init?.type === "CallExpression") {
      const callee = init.callee;
      if (callee?.type === "MemberExpression" && callee.property?.type === "Identifier" && callee.property.name === "meta") {
        return true;
      }
    }
  }
  return false;
};
var defaultExportsRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Story files should have a default export",
      recommended: false
    },
    messages: {
      shouldHaveDefaultExport: "The file should have a default export."
    },
    schema: []
  },
  defaultOptions: [],
  create(context) {
    let hasDefaultExport = false;
    let isCsf4Style = false;
    let hasStoriesOfImport = false;
    return {
      ImportSpecifier(node) {
        if (isStoriesOfImportSpecifier(node) === true)
          hasStoriesOfImport = true;
      },
      VariableDeclaration(node) {
        if (isCsf4MetaDeclaration(node) === true)
          isCsf4Style = true;
      },
      ExportDefaultDeclaration() {
        hasDefaultExport = true;
      },
      "Program:exit"(program) {
        if (isCsf4Style === true || hasDefaultExport === true || hasStoriesOfImport === true) {
          return;
        }
        const firstNonImport = program.body.find((n) => n.type !== "ImportDeclaration");
        const node = firstNonImport ?? program.body[0] ?? program;
        context.report({ node, messageId: "shouldHaveDefaultExport" });
      }
    };
  }
};

// src/storybook/hierarchy-separator.ts
var hierarchySeparatorRule = {
  meta: {
    type: "problem",
    fixable: "code",
    docs: {
      description: "Deprecated hierarchy separator in title property",
      recommended: false
    },
    messages: {
      deprecatedHierarchySeparator: "Deprecated hierarchy separator in title property: {{metaTitle}}."
    },
    schema: []
  },
  defaultOptions: [],
  create(context) {
    let program = null;
    return {
      Program(node) {
        program = node;
      },
      ExportDefaultDeclaration(node) {
        const meta = getMetaObjectExpression({ node, program });
        if (meta === null)
          return;
        const titleNode = meta.properties.find((prop) => prop.type !== "SpreadElement" && prop.key !== undefined && ("name" in prop.key) && prop.key.name === "title");
        if (titleNode === undefined || titleNode.value?.type !== "Literal")
          return;
        const metaTitle = titleNode.value.raw ?? "";
        if (metaTitle.includes("|") === true) {
          context.report({
            node: titleNode,
            messageId: "deprecatedHierarchySeparator",
            data: { metaTitle },
            fix: (fixer) => fixer.replaceTextRange(titleNode.value.range, metaTitle.replace(/\|/g, "/"))
          });
        }
      }
    };
  }
};

// src/storybook/meta-satisfies-type.ts
var findTopLevelConstDeclarator = (opts) => {
  const { program, name } = opts;
  if (program === undefined || program === null)
    return null;
  for (const stmt of program.body) {
    if (stmt.type !== "VariableDeclaration")
      continue;
    for (const decl of stmt.declarations) {
      if (decl.id?.type === "Identifier" && decl.id.name === name)
        return decl;
    }
  }
  return null;
};
var resolveMeta = (opts) => {
  const { node, program } = opts;
  let candidate = node.declaration;
  if (candidate?.type === "Identifier") {
    const declarator = findTopLevelConstDeclarator({ program, name: candidate.name });
    candidate = declarator?.init ?? null;
  }
  if (candidate === null || candidate === undefined)
    return null;
  if (candidate.type === "TSSatisfiesExpression") {
    return candidate.expression?.type === "ObjectExpression" ? { object: candidate.expression, satisfied: true } : null;
  }
  if (candidate.type === "TSAsExpression") {
    return candidate.expression?.type === "ObjectExpression" ? { object: candidate.expression, satisfied: false } : null;
  }
  return candidate.type === "ObjectExpression" ? { object: candidate, satisfied: false } : null;
};
var metaSatisfiesTypeRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Meta should use `satisfies Meta`",
      recommended: false
    },
    messages: {
      metaShouldSatisfyType: "CSF Meta should use `satisfies` for type safety"
    },
    schema: []
  },
  defaultOptions: [],
  create(context) {
    let program = null;
    return {
      Program(node) {
        program = node;
      },
      ExportDefaultDeclaration(node) {
        const resolved = resolveMeta({ node, program });
        if (resolved === null)
          return;
        if (resolved.satisfied === false) {
          context.report({ node: resolved.object, messageId: "metaShouldSatisfyType" });
        }
      }
    };
  }
};

// src/storybook/no-redundant-story-name.ts
var noRedundantStoryNameRule = {
  meta: {
    type: "suggestion",
    fixable: "code",
    docs: {
      description: "A story should not have a redundant name property",
      recommended: false
    },
    messages: {
      storyNameIsRedundant: "Named exports should not use the name annotation if it is redundant to the name that would be generated by the export name"
    },
    schema: []
  },
  defaultOptions: [],
  create(context) {
    return {
      ExportNamedDeclaration(node) {
        if (node.declaration === null || node.declaration === undefined)
          return;
        const decl = node.declaration;
        if (decl.type !== "VariableDeclaration")
          return;
        const declaration = decl.declarations[0];
        if (declaration === undefined || declaration === null)
          return;
        const id = declaration.id;
        const init = declaration.init;
        if (id?.type !== "Identifier" || init?.type !== "ObjectExpression")
          return;
        const storyNameNode = init.properties.find((prop) => prop.type === "Property" && prop.key?.type === "Identifier" && (prop.key.name === "name" || prop.key.name === "storyName"));
        if (storyNameNode === undefined)
          return;
        const resolvedStoryName = storyNameFromExport(id.name);
        if (storyNameNode.type !== "SpreadElement" && storyNameNode.value?.type === "Literal" && storyNameNode.value.value === resolvedStoryName) {
          context.report({
            node: storyNameNode,
            messageId: "storyNameIsRedundant",
            fix: (fixer) => fixer.remove(storyNameNode)
          });
        }
      },
      AssignmentExpression(node) {
        if (node.parent?.type !== "ExpressionStatement")
          return;
        const left = node.left;
        const right = node.right;
        if ("property" in left && left.property?.type === "Identifier" && left.object?.type !== "MetaProperty" && left.property.name === "storyName") {
          if (!("name" in left.object) || !("value" in right))
            return;
          const propertyName = left.object.name;
          const propertyValue = right.value;
          const resolvedStoryName = storyNameFromExport(propertyName);
          if (propertyValue === resolvedStoryName) {
            context.report({
              node,
              messageId: "storyNameIsRedundant",
              fix: (fixer) => fixer.remove(node)
            });
          }
        }
      }
    };
  }
};

// src/storybook/prefer-pascal-case.ts
var isPascalCase = (str) => /^[A-Z]+([a-z0-9]?)+/.test(str);
var preferPascalCaseRule = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Stories should use PascalCase",
      recommended: false
    },
    messages: {
      usePascalCase: "The story should use PascalCase notation: {{name}}"
    },
    schema: []
  },
  defaultOptions: [],
  create(context) {
    let program = null;
    let nonStoryExportsConfig = {};
    const namedExports = [];
    let hasStoriesOfImport = false;
    const checkAndReportError = (id) => {
      const name = id.name;
      if (isExportStory({ key: name, config: nonStoryExportsConfig }) === false || name === "__namedExportsOrder") {
        return;
      }
      if (name.startsWith("_") === false && isPascalCase(name) === false) {
        context.report({ node: id, messageId: "usePascalCase", data: { name } });
      }
    };
    return {
      Program(node) {
        program = node;
      },
      ImportSpecifier(node) {
        if (isStoriesOfImportSpecifier(node) === true)
          hasStoriesOfImport = true;
      },
      ExportDefaultDeclaration(node) {
        const meta = getMetaObjectExpression({ node, program });
        if (meta !== null) {
          nonStoryExportsConfig = {
            excludeStories: getDescriptor({ meta, propertyName: "excludeStories" }),
            includeStories: getDescriptor({ meta, propertyName: "includeStories" })
          };
        }
      },
      ExportNamedDeclaration(node) {
        if (node.declaration === null || node.declaration === undefined)
          return;
        const decl = node.declaration;
        if (decl.type === "VariableDeclaration") {
          const declaration = decl.declarations[0];
          if (declaration === undefined || declaration === null)
            return;
          if (declaration.id?.type === "Identifier")
            namedExports.push(declaration.id);
        }
      },
      "Program:exit"() {
        if (namedExports.length > 0 && hasStoriesOfImport === false) {
          for (const n of namedExports)
            checkAndReportError(n);
        }
      }
    };
  }
};

// src/storybook/story-exports.ts
var storyExportsRule = {
  meta: {
    type: "problem",
    docs: {
      description: "A story file must contain at least one story export",
      recommended: false
    },
    messages: {
      shouldHaveStoryExport: "The file should have at least one story export",
      shouldHaveStoryExportWithFilters: "The file should have at least one story export. Make sure the includeStories/excludeStories you defined are correct, otherwise Storybook will not use any stories for this file."
    },
    schema: []
  },
  defaultOptions: [],
  create(context) {
    let program = null;
    let hasStoriesOfImport = false;
    let nonStoryExportsConfig = {};
    let meta = null;
    const namedExports = [];
    return {
      Program(node) {
        program = node;
      },
      ImportSpecifier(node) {
        if (isStoriesOfImportSpecifier(node) === true)
          hasStoriesOfImport = true;
      },
      ExportDefaultDeclaration(node) {
        meta = getMetaObjectExpression({ node, program });
        if (meta !== null) {
          nonStoryExportsConfig = {
            excludeStories: getDescriptor({ meta, propertyName: "excludeStories" }),
            includeStories: getDescriptor({ meta, propertyName: "includeStories" })
          };
        }
      },
      ExportNamedDeclaration(node) {
        namedExports.push(...getAllNamedExports(node));
      },
      "Program:exit"(programNode) {
        if (hasStoriesOfImport === true || meta === null)
          return;
        const storyExports = namedExports.filter((exp) => isValidStoryExport({ name: exp.name, config: nonStoryExportsConfig }) === true);
        if (storyExports.length > 0)
          return;
        const firstNonImport = programNode.body.find((n) => n.type !== "ImportDeclaration");
        const node = firstNonImport ?? programNode.body[0] ?? programNode;
        const hasFilter = nonStoryExportsConfig.includeStories !== undefined || nonStoryExportsConfig.excludeStories !== undefined;
        context.report({
          node,
          messageId: hasFilter === true ? "shouldHaveStoryExportWithFilters" : "shouldHaveStoryExport"
        });
      }
    };
  }
};

// src/stylex-shared.ts
var createStylexImports = () => ({
  namespaces: new Set,
  creates: new Set
});
var trackStylexImport = ({
  imports,
  node
}) => {
  const source = node.source.value;
  if (source !== "@stylexjs/stylex" && source !== "stylex")
    return;
  for (const specifier of node.specifiers) {
    if (specifier.type === "ImportNamespaceSpecifier" || specifier.type === "ImportDefaultSpecifier") {
      imports.namespaces.add(specifier.local.name);
    }
    if (specifier.type === "ImportSpecifier" && specifier.imported.type === "Identifier" && specifier.imported.name === "create") {
      imports.creates.add(specifier.local.name);
    }
  }
};
var stylexCreateArgument = ({
  imports,
  node
}) => {
  if (node.arguments.length !== 1)
    return;
  let argument = node.arguments[0];
  while (argument !== undefined && (argument.type === "TSAsExpression" || argument.type === "TSSatisfiesExpression")) {
    argument = argument.expression;
  }
  if (argument === undefined || argument.type !== "ObjectExpression")
    return;
  const callee = node.callee;
  if (callee.type === "Identifier") {
    return imports.creates.has(callee.name) === true ? argument : undefined;
  }
  const isCreateMember = callee.type === "MemberExpression" && callee.computed === false && callee.property.type === "Identifier" && callee.property.name === "create" && callee.object.type === "Identifier" && (imports.namespaces.has(callee.object.name) === true || callee.object.name === "stylex");
  return isCreateMember === true ? argument : undefined;
};
var staticKeyName = (property) => {
  if (property.computed === true)
    return;
  const key = property.key;
  if (key.type === "Identifier")
    return key.name;
  if (key.type === "Literal" && typeof key.value === "string")
    return key.value;
  return;
};
var isConditionKey = (name) => name === "default" || /^[:@[&>~+*]/.test(name);

// src/stylex-no-raw-color.ts
var URL_FUNCTION_PATTERN = /url\([^)]*\)/gi;
var HEX_COLOR_PATTERN = /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})(?![\da-f])/i;
var COLOR_FUNCTION_PATTERN = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|device-cmyk)\((?!\s*from\b)/i;
var NAMED_COLORS = [
  "lightgoldenrodyellow",
  "mediumspringgreen",
  "mediumaquamarine",
  "mediumslateblue",
  "mediumturquoise",
  "mediumvioletred",
  "blanchedalmond",
  "cornflowerblue",
  "darkolivegreen",
  "lightslategray",
  "lightslategrey",
  "lightsteelblue",
  "mediumseagreen",
  "darkgoldenrod",
  "darkslateblue",
  "darkslategray",
  "darkslategrey",
  "darkturquoise",
  "lavenderblush",
  "lightseagreen",
  "palegoldenrod",
  "paleturquoise",
  "palevioletred",
  "rebeccapurple",
  "antiquewhite",
  "darkseagreen",
  "lemonchiffon",
  "lightskyblue",
  "mediumorchid",
  "mediumpurple",
  "midnightblue",
  "darkmagenta",
  "deepskyblue",
  "floralwhite",
  "forestgreen",
  "greenyellow",
  "lightsalmon",
  "lightyellow",
  "navajowhite",
  "saddlebrown",
  "springgreen",
  "yellowgreen",
  "aquamarine",
  "blueviolet",
  "chartreuse",
  "darkorange",
  "darkorchid",
  "darksalmon",
  "darkviolet",
  "dodgerblue",
  "ghostwhite",
  "lightcoral",
  "lightgreen",
  "mediumblue",
  "papayawhip",
  "powderblue",
  "sandybrown",
  "whitesmoke",
  "aliceblue",
  "burlywood",
  "cadetblue",
  "chocolate",
  "darkgreen",
  "darkkhaki",
  "firebrick",
  "gainsboro",
  "goldenrod",
  "indianred",
  "lawngreen",
  "lightblue",
  "lightcyan",
  "lightgray",
  "lightgrey",
  "lightpink",
  "limegreen",
  "mintcream",
  "mistyrose",
  "olivedrab",
  "orangered",
  "palegreen",
  "peachpuff",
  "rosybrown",
  "royalblue",
  "slateblue",
  "slategray",
  "slategrey",
  "steelblue",
  "turquoise",
  "cornsilk",
  "darkblue",
  "darkcyan",
  "darkgray",
  "darkgrey",
  "deeppink",
  "honeydew",
  "lavender",
  "moccasin",
  "seagreen",
  "seashell",
  "crimson",
  "darkred",
  "dimgray",
  "dimgrey",
  "fuchsia",
  "hotpink",
  "magenta",
  "oldlace",
  "skyblue",
  "thistle",
  "bisque",
  "indigo",
  "maroon",
  "orange",
  "orchid",
  "purple",
  "salmon",
  "sienna",
  "silver",
  "tomato",
  "violet",
  "yellow",
  "azure",
  "beige",
  "black",
  "brown",
  "coral",
  "green",
  "ivory",
  "khaki",
  "linen",
  "olive",
  "wheat",
  "white",
  "aqua",
  "blue",
  "cyan",
  "gold",
  "gray",
  "grey",
  "lime",
  "navy",
  "peru",
  "pink",
  "plum",
  "snow",
  "teal",
  "red",
  "tan"
];
var NAMED_COLOR_PATTERN = new RegExp(String.raw`(?<![\w-])(?:${NAMED_COLORS.join("|")})(?![\w-])`, "i");
var TEXT_VALUED_PROPERTIES = { content: true };
var rawColorIn = (value) => {
  const scrubbed = value.replaceAll(URL_FUNCTION_PATTERN, "url()");
  const hex = HEX_COLOR_PATTERN.exec(scrubbed);
  if (hex !== null)
    return hex[0];
  const fn = COLOR_FUNCTION_PATTERN.exec(scrubbed);
  if (fn !== null) {
    let depth = 0;
    for (let index = fn.index;index < scrubbed.length; index++) {
      const char = scrubbed[index];
      if (char === "(")
        depth = depth + 1;
      else if (char === ")") {
        depth = depth - 1;
        if (depth === 0)
          return scrubbed.slice(fn.index, index + 1);
      }
    }
    return scrubbed.slice(fn.index);
  }
  const named = NAMED_COLOR_PATTERN.exec(scrubbed);
  return named?.[0];
};
var walkValue = ({ context, node, property }) => {
  switch (node.type) {
    case "ObjectExpression": {
      for (const member of node.properties) {
        if (member.type !== "Property")
          continue;
        const key = staticKeyName(member);
        const nextProperty = key !== undefined && isConditionKey(key) === false ? key : property;
        walkValue({ context, node: member.value, property: nextProperty });
      }
      return;
    }
    case "Literal": {
      if (typeof node.value !== "string")
        return;
      if (property !== undefined && TEXT_VALUED_PROPERTIES[property] === true)
        return;
      const color = rawColorIn(node.value);
      if (color === undefined)
        return;
      context.report({
        node,
        messageId: "rawColor",
        data: { color, property: property ?? "a style value" }
      });
      return;
    }
    case "TemplateLiteral": {
      if (property === undefined || TEXT_VALUED_PROPERTIES[property] !== true) {
        const text = node.quasis.map((quasi) => quasi.value.cooked).join(" ");
        const color = rawColorIn(text);
        if (color !== undefined) {
          context.report({
            node,
            messageId: "rawColor",
            data: { color, property: property ?? "a style value" }
          });
        }
      }
      for (const expression of node.expressions) {
        walkValue({ context, node: expression, property });
      }
      return;
    }
    case "ConditionalExpression": {
      walkValue({ context, node: node.consequent, property });
      walkValue({ context, node: node.alternate, property });
      return;
    }
    case "LogicalExpression":
    case "BinaryExpression": {
      if (node.left.type !== "PrivateIdentifier") {
        walkValue({ context, node: node.left, property });
      }
      walkValue({ context, node: node.right, property });
      return;
    }
    case "ArrayExpression": {
      for (const element of node.elements) {
        if (element === null)
          continue;
        walkValue({ context, node: element, property });
      }
      return;
    }
    case "ArrowFunctionExpression":
    case "FunctionExpression": {
      walkValue({ context, node: node.body, property });
      return;
    }
    case "BlockStatement": {
      for (const statement of node.body) {
        walkValue({ context, node: statement, property });
      }
      return;
    }
    case "ReturnStatement": {
      if (node.argument !== null)
        walkValue({ context, node: node.argument, property });
      return;
    }
    case "IfStatement": {
      walkValue({ context, node: node.consequent, property });
      if (node.alternate !== null)
        walkValue({ context, node: node.alternate, property });
      return;
    }
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression": {
      walkValue({ context, node: node.expression, property });
      return;
    }
    default:
      return;
  }
};
var stylexNoRawColorRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Ban raw colour literals as values inside stylex.create",
      recommended: false
    },
    messages: {
      rawColor: "Raw colour `{{color}}` in `{{property}}`. Component styles must read colours from a semantic token exported by a `*.stylex.ts` module — a raw colour is an inlined constant and silently ignores the colour scheme. Move the value into the token layer and reference the token here."
    },
    schema: []
  },
  defaultOptions: [],
  create(context) {
    const imports = createStylexImports();
    return {
      ImportDeclaration(node) {
        trackStylexImport({ imports, node });
      },
      CallExpression(node) {
        const styleMap = stylexCreateArgument({ imports, node });
        if (styleMap === undefined)
          return;
        walkValue({ context, node: styleMap, property: undefined });
      }
    };
  }
};

// src/stylex-outline-focus-visible-only.ts
var FOCUS_RING_PROPERTIES = {
  outline: true,
  outlineOffset: true,
  outlineColor: true
};
var isStateCondition = (name) => {
  if (name === "default")
    return false;
  if (name.startsWith("@") === true)
    return false;
  if (name.startsWith("::") === true)
    return false;
  if (name.includes("focus-visible") === true)
    return false;
  return isConditionKey(name) === true;
};
var walkConditions = ({
  context,
  node,
  focusRingProperty,
  stateCondition
}) => {
  if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") {
    walkConditions({ context, node: node.body, focusRingProperty, stateCondition });
    return;
  }
  if (node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression" || node.type === "TSNonNullExpression") {
    walkConditions({ context, node: node.expression, focusRingProperty, stateCondition });
    return;
  }
  if (node.type !== "ObjectExpression")
    return;
  for (const member of node.properties) {
    if (member.type !== "Property")
      continue;
    const key = staticKeyName(member);
    if (key === undefined) {
      if (focusRingProperty !== undefined) {
        context.report({
          node: member,
          messageId: "outlineOutsideFocusVisible",
          data: { property: focusRingProperty, condition: "an observed `when.*` condition" }
        });
      }
      walkConditions({
        context,
        node: member.value,
        focusRingProperty,
        stateCondition: stateCondition ?? "an observed `when.*` condition"
      });
      continue;
    }
    if (isConditionKey(key) === true) {
      const isState = isStateCondition(key);
      if (isState === true && focusRingProperty !== undefined) {
        context.report({
          node: member,
          messageId: "outlineOutsideFocusVisible",
          data: { property: focusRingProperty, condition: key }
        });
      }
      walkConditions({
        context,
        node: member.value,
        focusRingProperty,
        stateCondition: isState === true ? stateCondition ?? key : stateCondition
      });
      continue;
    }
    const isFocusRing = FOCUS_RING_PROPERTIES[key] === true;
    if (isFocusRing === true && stateCondition !== undefined) {
      context.report({
        node: member,
        messageId: "outlineOutsideFocusVisible",
        data: { property: key, condition: stateCondition }
      });
    }
    walkConditions({
      context,
      node: member.value,
      focusRingProperty: isFocusRing === true ? key : focusRingProperty,
      stateCondition
    });
  }
};
var stylexOutlineFocusVisibleOnlyRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Reserve outline, outlineOffset and outlineColor for the focus-visible state",
      recommended: false
    },
    messages: {
      outlineOutsideFocusVisible: "`{{property}}` is reserved for the focus-visible state but is set under `{{condition}}`. StyleX orders conditions by kind, not by authoring position, so this state can silently outrank the focus ring on the same property. Restyle `boxShadow` or a background property for `{{condition}}` instead — partitioning the properties is what makes the focus ring collision-proof."
    },
    schema: []
  },
  defaultOptions: [],
  create(context) {
    const imports = createStylexImports();
    return {
      ImportDeclaration(node) {
        trackStylexImport({ imports, node });
      },
      CallExpression(node) {
        const styleMap = stylexCreateArgument({ imports, node });
        if (styleMap === undefined)
          return;
        for (const member of styleMap.properties) {
          if (member.type !== "Property")
            continue;
          walkConditions({
            context,
            node: member.value,
            focusRingProperty: undefined,
            stateCondition: undefined
          });
        }
      }
    };
  }
};

// src/mod.ts
var rules = {
  "explicit-boolean-compare": explicitBooleanCompareRule,
  "exports-first": exportsFirstRule,
  "jsdoc-require-exports": jsdocRequireExportsRule,
  "named-args": namedArgsRule,
  "no-external-imports": noExternalImportsRule,
  "no-non-durable-wait": noNonDurableWaitRule,
  "no-raw-nondeterminism": noRawNondeterminismRule,
  "no-raw-otel-primitives": noRawOtelPrimitivesRule,
  "otel-contract-in-seam-file": otelContractInSeamFileRule,
  "stylex-no-raw-color": stylexNoRawColorRule,
  "stylex-outline-focus-visible-only": stylexOutlineFocusVisibleOnlyRule,
  "storybook/meta-satisfies-type": metaSatisfiesTypeRule,
  "storybook/default-exports": defaultExportsRule,
  "storybook/story-exports": storyExportsRule,
  "storybook/csf-component": csfComponentRule,
  "storybook/hierarchy-separator": hierarchySeparatorRule,
  "storybook/no-redundant-story-name": noRedundantStoryNameRule,
  "storybook/prefer-pascal-case": preferPascalCaseRule
};
var plugin = {
  meta: {
    name: "overeng",
    version: "0.1.0"
  },
  rules
};
var mod_default = plugin;
export {
  mod_default as default
};
