/* eslint-disable no-console */
/* eslint-disable no-shadow */
/* eslint-disable global-require */
/* eslint-disable import/no-dynamic-require */
/* eslint-disable no-return-await */
/* eslint-disable no-use-before-define */
/* eslint-disable no-restricted-syntax */

const {
  GraphQLObjectType,
  GraphQLList,
  GraphQLString,
  GraphQLInt,
  GraphQLEnumType,
  GraphQLJSON,
  GraphQLBoolean
} = require(`gatsby/graphql`);
const Remark = require(`remark`);
const select = require(`unist-util-select`);
const sanitizeHTML = require(`sanitize-html`);
const _ = require(`lodash`);
const visit = require(`unist-util-visit`);
const toHAST = require(`mdast-util-to-hast`);
const hastToHTML = require(`hast-util-to-html`);
const mdastToToc = require(`mdast-util-toc`);
const Promise = require(`bluebird`);
const unified = require(`unified`);
const parse = require(`remark-parse`);
const stringify = require(`remark-stringify`);
const english = require(`retext-english`);
const remark2retext = require(`remark-retext`);
const stripPosition = require(`unist-util-remove-position`);
const hastReparseRaw = require(`hast-util-raw`);
const prune = require(`underscore.string/prune`);
const transformer = require("./transformer");

const {
  getConcatenatedValue,
  cloneTreeUntil,
  findLastTextNode
} = require(`./hast-processing`);

let fileNodes;
let pluginsCacheStr = ``;
let pathPrefixCacheStr = ``;
const astCacheKey = node =>
  `transformer-remark-markdown-ast-${
    node.internal.contentDigest
  }-${pluginsCacheStr}-${pathPrefixCacheStr}`;
const htmlCacheKey = node =>
  `transformer-remark-markdown-html-${
    node.internal.contentDigest
  }-${pluginsCacheStr}-${pathPrefixCacheStr}`;
const htmlAstCacheKey = node =>
  `transformer-remark-markdown-html-ast-${
    node.internal.contentDigest
  }-${pluginsCacheStr}-${pathPrefixCacheStr}`;
const headingsCacheKey = node =>
  `transformer-remark-markdown-headings-${
    node.internal.contentDigest
  }-${pluginsCacheStr}-${pathPrefixCacheStr}`;
const tableOfContentsCacheKey = (node, appliedTocOptions) =>
  `transformer-remark-markdown-toc-${
    node.internal.contentDigest
  }-${pluginsCacheStr}-${JSON.stringify(
    appliedTocOptions
  )}-${pathPrefixCacheStr}`;

// ensure only one `/` in new url
const withPathPrefix = (url, pathPrefix) =>
  (pathPrefix + url).replace(/\/\//, `/`);

// TODO: remove this check with next major release
const safeGetCache = ({ getCache, cache }) => id => {
  if (!getCache) {
    return cache;
  }
  return getCache(id);
};

/**
 * Map that keeps track of generation of AST to not generate it multiple
 * times in parallel.
 *
 * @type {Map<string,Promise>}
 */
const ASTPromiseMap = new Map();

module.exports = (
  {
    type,
    pathPrefix,
    getNode,
    getNodesByType,
    cache,
    getCache: possibleGetCache,
    reporter,
    ...rest
  },
  pluginOptions
) => {
  if (type.name !== `MarkdownRemark`) {
    return {};
  }
  pluginsCacheStr = pluginOptions.plugins.map(p => p.name).join(``);
  pathPrefixCacheStr = pathPrefix || ``;

  const getCache = safeGetCache({ cache, getCache: possibleGetCache });

  return new Promise(resolve => {
    // Setup Remark.
    const {
      blocks,
      commonmark = true,
      footnotes = true,
      gfm = true,
      pedantic = true,
      tableOfContents = {
        heading: null,
        maxDepth: 6
      }
    } = pluginOptions;
    const tocOptions = tableOfContents;
    const remarkOptions = {
      commonmark,
      footnotes,
      gfm,
      pedantic
    };
    if (_.isArray(blocks)) {
      remarkOptions.blocks = blocks;
    }
    let remark = new Remark().data(`settings`, remarkOptions);

    for (const plugin of pluginOptions.plugins) {
      const requiredPlugin = require(plugin.resolve);
      if (_.isFunction(requiredPlugin.setParserPlugins)) {
        for (const parserPlugin of requiredPlugin.setParserPlugins(
          plugin.pluginOptions
        )) {
          if (_.isArray(parserPlugin)) {
            const [parser, options] = parserPlugin;
            remark = remark.use(parser, options);
          } else {
            remark = remark.use(parserPlugin);
          }
        }
      }
    }

    async function getAST(markdownNode) {
      const cacheKey = astCacheKey(markdownNode);
      const cachedAST = await cache.get(cacheKey);
      if (cachedAST) {
        return cachedAST;
      }
      if (ASTPromiseMap.has(cacheKey)) {
        // We are already generating AST, so let's wait for it
        return await ASTPromiseMap.get(cacheKey);
      }
      const ASTGenerationPromise = getMarkdownAST(markdownNode);
      ASTGenerationPromise.then(markdownAST => {
        cache.set(cacheKey, markdownAST);
        ASTPromiseMap.delete(cacheKey);
      }).catch(err => {
        ASTPromiseMap.delete(cacheKey);
        return err;
      });
      // Save new AST to cache and return
      // We can now release promise, as we cached result
      ASTPromiseMap.set(cacheKey, ASTGenerationPromise);
      return ASTGenerationPromise;
    }

    async function getMarkdownAST(markdownNode) {
      if (process.env.NODE_ENV !== `production` || !fileNodes) {
        fileNodes = getNodesByType(`File`);
      }
      // Use Bluebird's Promise function "each" to run remark plugins serially.
      await Promise.each(pluginOptions.plugins, plugin => {
        const requiredPlugin = require(plugin.resolve);
        if (_.isFunction(requiredPlugin.mutateSource)) {
          return requiredPlugin.mutateSource(
            {
              markdownNode,
              files: fileNodes,
              getNode,
              reporter,
              cache: getCache(plugin.name),
              getCache,
              ...rest
            },
            plugin.pluginOptions
          );
        }
        return Promise.resolve();
      });
      const markdownAST = remark.parse(markdownNode.internal.content);

      if (pathPrefix) {
        // Ensure relative links include `pathPrefix`
        visit(markdownAST, [`link`, `definition`], node => {
          if (
            node.url &&
            node.url.startsWith(`/`) &&
            !node.url.startsWith(`//`)
          ) {
            node.url = withPathPrefix(node.url, pathPrefix);
          }
        });
      }

      // source => parse (can order parsing for dependencies) => typegen
      //
      // source plugins identify nodes, provide id, initial parse, know
      // when nodes are created/removed/deleted
      // get passed cached DataTree and return list of clean and dirty nodes.
      // Also get passed `dirtyNodes` function which they can call with an array
      // of node ids which will then get re-parsed and the inferred schema
      // recreated (if inferring schema gets too expensive, can also
      // cache the schema until a query fails at which point recreate the
      // schema).
      //
      // parse plugins take data from source nodes and extend it, never mutate
      // it. Freeze all nodes once done so typegen plugins can't change it
      // this lets us save off the DataTree at that point as well as create
      // indexes.
      //
      // typegen plugins identify further types of data that should be lazily
      // computed due to their expense, or are hard to infer graphql type
      // (markdown ast), or are need user input in order to derive e.g.
      // markdown headers or date fields.
      //
      // wrap all resolve functions to (a) auto-memoize and (b) cache to disk any
      // resolve function that takes longer than ~10ms (do research on this
      // e.g. how long reading/writing to cache takes), and (c) track which
      // queries are based on which source nodes. Also if connection of what
      // which are always rerun if their underlying nodes change..
      //
      // every node type in DataTree gets a schema type automatically.
      // typegen plugins just modify the auto-generated types to add derived fields
      // as well as computationally expensive fields.
      if (process.env.NODE_ENV !== `production` || !fileNodes) {
        fileNodes = getNodesByType(`File`);
      }
      // Use Bluebird's Promise function "each" to run remark plugins serially.
      await Promise.each(pluginOptions.plugins, plugin => {
        const requiredPlugin = require(plugin.resolve);
        if (_.isFunction(requiredPlugin)) {
          return requiredPlugin(
            {
              markdownAST,
              markdownNode,
              getNode,
              files: fileNodes,
              pathPrefix,
              reporter,
              cache: getCache(plugin.name),
              getCache,
              ...rest
            },
            plugin.pluginOptions
          );
        }
        return Promise.resolve();
      });

      return markdownAST;
    }

    async function getHeadings(markdownNode) {
      const cachedHeadings = await cache.get(headingsCacheKey(markdownNode));
      if (cachedHeadings) {
        return cachedHeadings;
      }
      const ast = await getAST(markdownNode);
      const headings = select(ast, `heading`).map(heading => {
        return {
          value: _.first(select(heading, `text`).map(text => text.value)),
          depth: heading.depth
        };
      });

      cache.set(headingsCacheKey(markdownNode), headings);
      return headings;
    }

    async function getTableOfContents(markdownNode, gqlTocOptions) {
      // fetch defaults
      const appliedTocOptions = { ...tocOptions, ...gqlTocOptions };
      // get cached toc
      const cachedToc = await cache.get(
        tableOfContentsCacheKey(markdownNode, appliedTocOptions)
      );
      if (cachedToc) {
        return cachedToc;
      }
      const ast = await getAST(markdownNode);
      const tocAst = mdastToToc(ast, appliedTocOptions);

      let toc;
      if (tocAst.map) {
        const addSlugToUrl = function(node) {
          if (node.url) {
            if (
              _.get(markdownNode, appliedTocOptions.pathToSlugField) ===
              undefined
            ) {
              console.warn(
                `Skipping TableOfContents. Field '${
                  appliedTocOptions.pathToSlugField
                }' missing from markdown node`
              );
              return null;
            }
            node.url = [
              pathPrefix,
              _.get(markdownNode, appliedTocOptions.pathToSlugField),
              node.url
            ]
              .join(`/`)
              .replace(/\/\//g, `/`);
          }
          if (node.children) {
            node.children = node.children.map(node => addSlugToUrl(node));
          }

          return node;
        };
        tocAst.map = addSlugToUrl(tocAst.map);

        toc = hastToHTML(toHAST(tocAst.map));
      } else {
        toc = ``;
      }
      cache.set(tableOfContentsCacheKey(markdownNode, appliedTocOptions), toc);
      return toc;
    }

    async function getHTMLAst(markdownNode) {
      const cachedAst = await cache.get(htmlAstCacheKey(markdownNode));
      if (cachedAst) {
        return cachedAst;
      }
      const ast = await getAST(markdownNode);
      const htmlAst = toHAST(ast, { allowDangerousHTML: true });

      // Save new HTML AST to cache and return
      cache.set(htmlAstCacheKey(markdownNode), htmlAst);
      return htmlAst;
    }

    async function getHTML(markdownNode) {
      const cachedHTML = await cache.get(htmlCacheKey(markdownNode));
      if (cachedHTML) {
        return cachedHTML;
      }
      const ast = await getHTMLAst(markdownNode);
      // Save new HTML to cache and return
      const html = hastToHTML(ast, {
        allowDangerousHTML: true
      });

      // Save new HTML to cache and return
      cache.set(htmlCacheKey(markdownNode), html);
      return html;
    }

    async function getMdCode(markdownNode) {
      const { slug } = markdownNode.fields;
      if (slug.includes("/demo/")) {
        const ast = remark.parse(markdownNode.internal.content);
        let code = "";
        visit(ast, "code", node => {
          if (node.value) {
            node.value = transformer(node.value);
            code = node.value;
          }
        });
        return code;
      }
      return "";
    }

    async function getHTMLContent(markdownNode) {
      const { slug } = markdownNode.fields;
      if (slug.includes("/demo/")) {
        const ast = await getHTMLAst(markdownNode);
        const dividerIndex = ast.children.findIndex(item => {
          return item.type === "raw" && item.value.includes("gatsby-highlight");
        });
        if (dividerIndex < 0) {
          return "";
        }
        const contentAst = ast.children.slice(0, dividerIndex);
        const contentMap = { "zh-CN": contentAst, "en-US": contentAst };
        let title = "";
        contentAst.forEach(node => {
          if (node.tagName === "h2") {
            if (node.children[0].value) {
              title = node.children[0].value;
              contentMap[title] = [];
            }
          }
          if (!title) {
            return;
          }
          if (node.tagName !== "h2") {
            contentMap[title].push(node);
          }
        });

        const highlightedCode = hastToHTML(
          {
            ...ast,
            children: ast.children.slice(dividerIndex, ast.children.length)
          },
          {
            allowDangerousHTML: true
          }
        );
        return {
          content: {
            "zh-CN": hastToHTML(
              {
                ...ast,
                children: contentMap["zh-CN"] || contentAst
              },
              {
                allowDangerousHTML: true
              }
            ),
            "en-US": hastToHTML(
              {
                ...ast,
                children: contentMap["en-US"] || contentAst
              },
              {
                allowDangerousHTML: true
              }
            )
          },
          highlightedCode
        };
      }
      return "";
    }

    async function getHTMLDescription(markdownNode) {
      // const cachedHTML = await cache.get(htmlDescriptionCacheKey(markdownNode));
      // if (cachedHTML) {
      //   return JSON.parse(cachedHTML);
      // }
      const ast = await getHTMLAst(markdownNode);
      const dividerIndex = ast.children.findIndex(item => {
        if (item.tagName === "h2") {
          return (
            item.children &&
            item.children[0] &&
            item.children[0].value === "API"
          );
        }
        return false;
      });
      if (dividerIndex < 0) {
        return {
          description: "",
          api: ""
        };
      }
      const descriptionAst = {
        ...ast,
        children: ast.children.slice(0, dividerIndex)
      };
      const apiAst = {
        ...ast,
        children: ast.children.slice(dividerIndex, ast.children.length)
      };
      // Save new HTML to cache and return
      const descriptionHtml = hastToHTML(descriptionAst, {
        allowDangerousHTML: true
      });
      const apiHtml = hastToHTML(apiAst, {
        allowDangerousHTML: true
      });

      // // Save new HTML to cache and return
      // cache.set(
      //   htmlDescriptionCacheKey(markdownNode),
      //   JSON.stringify({ description, api })
      // );
      return { descriptionHtml, apiHtml };
    }

    const HeadingType = new GraphQLObjectType({
      name: `MarkdownHeading`,
      fields: {
        value: {
          type: GraphQLString,
          resolve(heading) {
            return heading.value;
          }
        },
        depth: {
          type: GraphQLInt,
          resolve(heading) {
            return heading.depth;
          }
        }
      }
    });

    const HeadingLevels = new GraphQLEnumType({
      name: `HeadingLevels`,
      values: {
        h1: { value: 1 },
        h2: { value: 2 },
        h3: { value: 3 },
        h4: { value: 4 },
        h5: { value: 5 },
        h6: { value: 6 }
      }
    });

    const ExcerptFormats = new GraphQLEnumType({
      name: `ExcerptFormats`,
      values: {
        PLAIN: { value: `plain` },
        HTML: { value: `html` }
      }
    });

    return resolve({
      html: {
        type: GraphQLString,
        resolve(markdownNode) {
          return getHTML(markdownNode);
        }
      },
      htmlAst: {
        type: GraphQLJSON,
        resolve(markdownNode) {
          return getHTMLAst(markdownNode).then(ast => {
            const strippedAst = stripPosition(_.clone(ast), true);
            return hastReparseRaw(strippedAst);
          });
        }
      },
      description: {
        type: GraphQLJSON,
        resolve(markdownNode) {
          return getHTMLDescription(markdownNode);
        }
      },
      code: {
        type: GraphQLString,
        resolve(markdownNode) {
          return getMdCode(markdownNode);
        }
      },
      content: {
        type: GraphQLJSON,
        resolve(markdownNode) {
          return getHTMLContent(markdownNode);
        }
      },
      excerpt: {
        type: GraphQLString,
        args: {
          pruneLength: {
            type: GraphQLInt,
            defaultValue: 140
          },
          truncate: {
            type: GraphQLBoolean,
            defaultValue: false
          },
          format: {
            type: ExcerptFormats,
            defaultValue: `plain`
          }
        },
        async resolve(markdownNode, { format, pruneLength, truncate }) {
          if (format === `html`) {
            if (pluginOptions.excerpt_separator) {
              const fullAST = await getHTMLAst(markdownNode);
              const excerptAST = cloneTreeUntil(
                fullAST,
                ({ nextNode }) =>
                  nextNode.type === `raw` &&
                  nextNode.value === pluginOptions.excerpt_separator
              );
              return hastToHTML(excerptAST, {
                allowDangerousHTML: true
              });
            }
            const fullAST = await getHTMLAst(markdownNode);
            if (!fullAST.children.length) {
              return ``;
            }

            const excerptAST = cloneTreeUntil(fullAST, ({ root }) => {
              const totalExcerptSoFar = getConcatenatedValue(root);
              return (
                totalExcerptSoFar && totalExcerptSoFar.length > pruneLength
              );
            });
            const unprunedExcerpt = getConcatenatedValue(excerptAST);
            if (!unprunedExcerpt) {
              return ``;
            }

            if (pruneLength && unprunedExcerpt.length < pruneLength) {
              return hastToHTML(excerptAST, {
                allowDangerousHTML: true
              });
            }

            const lastTextNode = findLastTextNode(excerptAST);
            const amountToPruneLastNode =
              pruneLength -
              (unprunedExcerpt.length - lastTextNode.value.length);
            if (!truncate) {
              lastTextNode.value = prune(
                lastTextNode.value,
                amountToPruneLastNode,
                `…`
              );
            } else {
              lastTextNode.value = _.truncate(lastTextNode.value, {
                length: pruneLength,
                omission: `…`
              });
            }
            return hastToHTML(excerptAST, {
              allowDangerousHTML: true
            });
          }
          if (markdownNode.excerpt) {
            return Promise.resolve(markdownNode.excerpt);
          }
          return getAST(markdownNode).then(ast => {
            const excerptNodes = [];
            visit(ast, node => {
              if (node.type === `text` || node.type === `inlineCode`) {
                excerptNodes.push(node.value);
              }
            });
            if (!truncate) {
              return prune(excerptNodes.join(` `), pruneLength, `…`);
            }
            return _.truncate(excerptNodes.join(` `), {
              length: pruneLength,
              omission: `…`
            });
          });
        }
      },
      headings: {
        type: new GraphQLList(HeadingType),
        args: {
          depth: {
            type: HeadingLevels
          }
        },
        resolve(markdownNode, { depth }) {
          return getHeadings(markdownNode).then(headings => {
            if (typeof depth === `number`) {
              headings = headings.filter(heading => heading.depth === depth);
            }
            return headings;
          });
        }
      },
      timeToRead: {
        type: GraphQLInt,
        resolve(markdownNode) {
          return getHTML(markdownNode).then(html => {
            let timeToRead = 0;
            const pureText = sanitizeHTML(html, { allowTags: [] });
            const avgWPM = 265;
            const wordCount = _.words(pureText).length;
            timeToRead = Math.round(wordCount / avgWPM);
            if (timeToRead === 0) {
              timeToRead = 1;
            }
            return timeToRead;
          });
        }
      },
      tableOfContents: {
        type: GraphQLString,
        args: {
          pathToSlugField: {
            type: GraphQLString,
            defaultValue: `fields.slug`
          },
          maxDepth: {
            type: GraphQLInt
          },
          heading: {
            type: GraphQLString
          }
        },
        resolve(markdownNode, args) {
          return getTableOfContents(markdownNode, args);
        }
      },
      // TODO add support for non-latin languages https://github.com/wooorm/remark/issues/251#issuecomment-296731071
      wordCount: {
        type: new GraphQLObjectType({
          name: `wordCount`,
          fields: {
            paragraphs: {
              type: GraphQLInt
            },
            sentences: {
              type: GraphQLInt
            },
            words: {
              type: GraphQLInt
            }
          }
        }),
        resolve(markdownNode) {
          const counts = {};

          unified()
            .use(parse)
            .use(
              remark2retext,
              unified()
                .use(english)
                .use(count)
            )
            .use(stringify)
            .processSync(markdownNode.internal.content);

          return {
            paragraphs: counts.ParagraphNode,
            sentences: counts.SentenceNode,
            words: counts.WordNode
          };

          function count() {
            return counter;
            function counter(tree) {
              visit(tree, visitor);
              function visitor(node) {
                counts[node.type] = (counts[node.type] || 0) + 1;
              }
            }
          }
        }
      }
    });
  });
};
