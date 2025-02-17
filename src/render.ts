import {dirname, parse, relative, resolve, sep} from 'path'
import fs, {readFileSync} from 'fs'
import {fileSyntax, sourceMappingURL} from './utils'
import * as sass from 'sass'
import {ImporterResult} from 'sass'
import {fileURLToPath, pathToFileURL} from 'url'
import {SassPluginOptions} from './index'

export type RenderSync = (path: string) => RenderResult

export type RenderResult = {
  cssText: string
  watchFiles: string[]
}

export function createRenderer(options: SassPluginOptions = {}, sourcemap: boolean): RenderSync {

  const loadPaths = options.loadPaths!

  /**
   * NOTE: we're deliberately ignoring sass recommendation to avoid sacrificing speed here!
   * - we prefer fragment attempt over syntax attempt
   * - we prefer .scss and .css over .sass
   * - we don't throw exceptions if the URL is ambiguous
   */
  function resolveImport(pathname: string, ext?: string): string | null {
    if (ext) {
      let filename = pathname + ext
      if (fs.existsSync(filename)) {
        return filename
      }
      const index = filename.lastIndexOf(sep)
      filename = index >= 0 ? filename.slice(0, index) + sep + '_' + filename.slice(index + 1) : '_' + filename
      if (fs.existsSync(filename)) {
        return filename
      }
      return null
    } else {
      if (!fs.existsSync(dirname(pathname))) {
        return null
      }
      return resolveImport(pathname, '.scss')
        || resolveImport(pathname, '.css')
        || resolveImport(pathname, '.sass')
        || resolveImport(pathname + sep + 'index')
    }
  }

  function resolveRelativeImport(loadPath: string, filename: string): string | null {
    const absolute = resolve(loadPath, filename)
    const pathParts = parse(absolute)
    if (pathParts.ext) {
      return resolveImport(pathParts.dir + sep + pathParts.name, pathParts.ext)
    } else {
      return resolveImport(absolute)
    }
  }

  const requireOptions = {paths: ['.', ...loadPaths]}

  const sepTilde = `${sep}~`

  /**
   * renderSync
   */
  return function (path: string): RenderResult {

    const basedir = dirname(path)

    let source = fs.readFileSync(path, 'utf-8')
    if (options.precompile) {
      source = options.precompile(source, path)
    }

    const syntax = fileSyntax(path)
    if (syntax === 'css') {
      return {cssText: readFileSync(path, 'utf-8'), watchFiles: [path]}
    }

    const {
      css,
      loadedUrls,
      sourceMap
    } = sass.compileString(source, {
      ...options,
      syntax,
      importer: {
        load(canonicalUrl: URL): ImporterResult | null {
          const pathname = fileURLToPath(canonicalUrl)
          let contents = fs.readFileSync(pathname, 'utf8')
          if (options.precompile) {
            contents = options.precompile(contents, pathname)
          }
          return {
            contents,
            syntax: fileSyntax(pathname),
            sourceMapUrl: sourcemap ? canonicalUrl : undefined
          }
        },
        canonicalize(url: string): URL | null {
          let filename
          if (url.startsWith('~')) {
            filename = decodeURI(url.slice(1))
            try {
              requireOptions.paths[0] = basedir
              filename = require.resolve(filename, requireOptions)
            } catch (ignored) {
            }
          } else if (url.startsWith('file://')) {
            filename = fileURLToPath(url)
            // ================================================ patch for: https://github.com/sass/dart-sass/issues/1581
            let joint = filename.lastIndexOf(sepTilde)
            if (joint >= 0) {
              const basedir = filename.slice(0, joint)
              filename = filename.slice(joint + 2)
              try {
                requireOptions.paths[0] = basedir
                filename = require.resolve(filename, requireOptions)
              } catch (ignored) {
              }
            }
            // =========================================================================================================
          } else {
            filename = decodeURI(url)
          }
          if (options.importMapper) {
            filename = options.importMapper(filename)
          }
          let resolved = resolveRelativeImport(basedir, filename)
          if (resolved) {
            return pathToFileURL(resolved)
          }
          for (const loadPath of loadPaths) {
            resolved = resolveRelativeImport(loadPath, filename)
            if (resolved) {
              return pathToFileURL(resolved)
            }
          }
          return null
        }
      },
      sourceMap: sourcemap
    })

    let cssText = css.toString()

    if (sourceMap) {
      sourceMap.sourceRoot = basedir
      sourceMap.sources = sourceMap.sources.map(source => {
        return relative(basedir, source.startsWith("data:") ? path : fileURLToPath(source))
      })
      cssText += '\n' + sourceMappingURL(sourceMap)
    }

    return {
      cssText,
      watchFiles: [path, ...loadedUrls.map(fileURLToPath)]
    }
  }
}