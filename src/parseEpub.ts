import fs from 'node:fs'
import { Buffer } from 'node:buffer'

import type { ParserOptions, GeneralObject } from './types'
import AdmZip from 'adm-zip'
import parseLink from './parseLink'
import parseSection, { Section } from './parseSection'
import { xmlToJson, determineRoot } from './utils'

// Lodash replacements
const get = (obj: any, path: string[], defaultValue: any = undefined): any => {
  let result = obj
  for (const key of path) {
    if (result == null) return defaultValue
    result = result[key]
  }
  return result ?? defaultValue
}

const pickBy = <T extends Record<string, any>>(
  obj: T,
  predicate: (value: any, key: string) => boolean
): Partial<T> => {
  const result: Partial<T> = {}
  for (const key of Object.keys(obj)) {
    if (predicate(obj[key], key)) {
      result[key as keyof T] = obj[key]
    }
  }
  return result
}

type MetaInfo = Partial<{
  title: string,
  author: string | string[],
  description: string,
  language: string,
  publisher: string,
  rights: string,
}>

const parseMetadata = (metadata: GeneralObject = {}): MetaInfo => {
  const meta = metadata;
  const info: MetaInfo = {};

  (['title', 'author', 'description', 'language', 'publisher', 'rights'] as (keyof MetaInfo)[]).forEach((item: keyof MetaInfo) => {
    if (item === 'author') {
      const author = get(meta, ['dc:creator'], [])
      if (Array.isArray(author)) {
        info.author = author.map((a) => a['#text'])
      } else {
        info.author = [author?.['#text']]
      }
    }
    else if (item === 'description') {
      info.description = get(meta, [item, '_'])
    }
    else {
      info[item] = get(meta, ['dc:' + item]) as string
    }
  })

  return pickBy(info, (v: string | string[]) => {
    if (Array.isArray(v)) return v.length !== 0 && v[0] !== undefined
    return v !== undefined
  }) as MetaInfo
}

export const defaultOptions = { type: "path", expand: false } as ParserOptions

export interface TOCItem {
  name: string
  sectionId: string
  nodeId: string
  path: string
  playOrder: number | string
  children?: TOCItem[]
}

interface Manifest {
  href: string
  id: string
  [k: string]: string
}

export class Epub {
  private _zip: AdmZip
  private _opfPath?: string
  private _root?: string
  private _content?: GeneralObject
  private _manifest?: Manifest[]
  // only for html/xhtml, not include images/css/js
  private _spine?: Record<string, number> // array of ids defined in manifest

  private _toc?: GeneralObject
  private _metadata?: GeneralObject
  private _options: ParserOptions = defaultOptions

  structure?: TOCItem[]
  info?: MetaInfo
  sections?: Section[]
  tocFile?: string

  constructor(input: string | Buffer, options?: ParserOptions) {
    // AdmZip accepts either a file path (string) or a Buffer
    this._zip = new AdmZip(input)
    if (options) this._options = { ...defaultOptions, ...options }
  }

  /**
   * get specific file from epub book.
   */
  resolve(path: string): {
    asText: () => string
    asNodeBuffer: () => Buffer
  } {
    let _path
    if (path[0] === '/') {
      // use absolute path, root is zip root
      _path = path.substring(1)
    } else {
      _path = this._root + path
    }
    const decodedPath = decodeURI(_path)
    const entry = this._zip.getEntry(decodedPath)
    if (entry) {
      return {
        asText: () => entry.getData().toString('utf8'),
        asNodeBuffer: () => entry.getData()
      }
    } else {
      throw new Error(`${_path} not found!`)
    }
  }

  _resolveXMLAsJsObject(path: string): GeneralObject {
    const xml = this.resolve(path).asText()
    return xmlToJson(xml)
  }

  /**
   * Get the path of the OPF (Open Packaging Format) file in the EPUB file.
   */
  private _getOpfPath(): string {
    return this._resolveXMLAsJsObject('/META-INF/container.xml').container.rootfiles.rootfile['@full-path']
  }


  /**
   * Parse the corresponding ID according to the link.
   * @param {string} href - The link to be resolved.
   * @return {string} The ID of the item.
   */
  private _resolveIdFromLink(href: string): string {
    const { name: tarName } = parseLink(href)
    const tarItem = this._manifest?.find((item: Manifest) => {
      const { name } = parseLink(item.href)
      return name === tarName
    })
    return tarItem?.id ?? ''
  }

  /**
   * Resolves the item ID from a given href link in the EPUB manifest.
   *
   * @param {string} href - The href link to resolve the item ID for.
   * @returns {string} The corresponding item ID from the manifest.
   */
  getItemId(href: string): string {
    return this._resolveIdFromLink(href)
  }

  /**
   * Get the manifest of the EPUB file.
   *
   * @returns {Manifest[]} An array of manifest items.
   */
  getManifest(content?: GeneralObject): Manifest[] {
    return (
      this._manifest ||
      (get(content, ['package', 'manifest', 'item'], []).map((item: any) => ({
        href: item['@href'],
        id: item['@id'],
      })
      ))
    )
  }

  getSpine(): Record<string, number> {
    const spine: Record<string, number> = {}
    this.getManifest()
    let itemRefs = get(this._content, ['package', 'spine', 'itemref'], [])
    if (!Array.isArray(itemRefs)) itemRefs = [itemRefs]
    itemRefs.map(
      (item: GeneralObject, i: number) => {
        return spine[item['@idref']] = i
      },
    )
    return spine
  }

  /** for toc is toc.html  */
  private _genStructureForHTML(tocObj: GeneralObject) {
    const tocRoot = tocObj.html.body[0].nav[0]['ol'][0].li
    let runningIndex = 1

    const parseHTMLNavPoints = (navPoint: GeneralObject) => {
      const element = navPoint.a[0] || {}
      const path = element['$'].href
      let name = element['_']
      const prefix = element.span
      if (prefix) {
        name = `${prefix.map((p: GeneralObject) => p['_']).join('')}${name}`
      }
      const sectionId = this._resolveIdFromLink(path)
      const { hash: nodeId } = parseLink(path)
      const playOrder = runningIndex

      let children = navPoint?.ol?.[0]?.li

      if (children) {
        children = parseOuterHTML(children)
      }

      runningIndex++

      return {
        name,
        sectionId,
        nodeId,
        path,
        playOrder,
        children,
      }
    }

    const parseOuterHTML = (collection: GeneralObject[]) => {
      return collection.map((point) => parseHTMLNavPoints(point))
    }

    return parseOuterHTML(tocRoot)
  }

  /**
   * Generates a structured table of contents from the EPUB's navigation data
   * @param tocObj - The table of contents object from the EPUB file
   * @param resolveNodeId - Optional flag to resolve node IDs
   * @returns Array of TOCItem objects representing the hierarchical structure
   * @internal
   */
  _genStructure(tocObj: GeneralObject, resolveNodeId = false): TOCItem[] {
    if (tocObj.html) {
      return this._genStructureForHTML(tocObj)
    }

    // may be GeneralObject or GeneralObject[] or []
    const rootNavPoints = get(tocObj, ['ncx', 'navMap', 'navPoint'], [])
    const parseNavPoint = (navPoint: GeneralObject) => {
      // link to section
      const path = get(navPoint, ['content', '@src'], '')
      const name = get(navPoint, ['navLabel', 'text'])

      const playOrder = get(navPoint, ['@playOrder']) as string
      const { hash } = parseLink(path)

      let children = navPoint.navPoint
      if (children) {
        // tslint:disable-next-line:no-use-before-declare
        children = parseNavPoints(children)
      }

      const sectionId = this._resolveIdFromLink(path)

      return {
        name,
        sectionId,
        nodeId: hash || navPoint['@id'],
        path,
        playOrder,
        children,
      }
    }

    const parseNavPoints = (navPoints: GeneralObject[]) => {
      // check if it's array or not
      return (Array.isArray(navPoints) ? navPoints : [navPoints])
        .map((point) => parseNavPoint(point))
    }

    return parseNavPoints(rootNavPoints)
  }

  /**
   * Resolves and parses sections of an EPUB document.
   *
   * @param {string} [id] - Optional specific section ID to resolve. If not provided, resolves all sections.
   * @returns {Section[]} An array of parsed document sections.
   * ```example
   * Section {
   *  id: "chapter_104",
   *  htmlString: "...",
   *  htmlObjects: [
   *    {
   *      tag: "p",
   *      content: "...",
   *      attributes: {
   *        class: "paragraph"
   *      }
   *    }
   *  ]
   *  ...
   * }[]
   * ```
   * @private
   */
  private _resolveSections(id?: string) {
    let list: any[] = [...new Set(Object.keys(this._spine!))]
    // no chain
    if (id) {
      list = [id];
    }
    return list.map((id) => {
      const item = this._manifest?.find(m => m.id === id)
      const path = item!.href
      const html = this.resolve(path).asText()

      const section = parseSection({
        id,
        htmlString: html,
        resourceResolver: this.resolve.bind(this),
        idResolver: this._resolveIdFromLink.bind(this),
        expand: this._options.expand,
      })

      if (this._options.convertToMarkdown) {
        section.register(this._options.convertToMarkdown)
      }
      return section
    })
  }

  getSection(id: string): Section | null {
    let sectionIndex = -1
    // console.log(id, this.getManifest())
    if (this._spine) sectionIndex = this._spine[id]
    // fix other html ont include spine structure
    if (sectionIndex === undefined) {
      return this._resolveSections(id)[0]
    }
    return this.sections ? sectionIndex != -1 ? this.sections[sectionIndex] : null : null
  }

  async parse(): Promise<Epub> {
    this._opfPath = this._getOpfPath()
    this._content = this._resolveXMLAsJsObject('/' + this._opfPath)
    this._root = determineRoot(this._opfPath)

    this._manifest = this.getManifest(this._content)
    this._metadata = get(this._content, ['package', 'metadata'], {})

    // https://github.com/gaoxiaoliangz/epub-parser/issues/13
    // https://www.w3.org/publishing/epub32/epub-packages.html#sec-spine-elem
    this.tocFile = (this._manifest?.find(m => m.id === 'ncx') || {}).href
    if (this.tocFile) {
      const toc = this._resolveXMLAsJsObject(this.tocFile)
      this._toc = toc
      this.structure = this._genStructure(toc)
    }

    this._spine = this.getSpine()
    this.info = parseMetadata(this._metadata)
    this.sections = this._resolveSections()

    return this
  }
}


export default function parserWrapper(target: string | Buffer, opts?: ParserOptions): Promise<Epub> {
  const options = { ...defaultOptions, ...opts }
  let _target: string | Buffer = target

  // If target is a string path, pass it directly to AdmZip (more efficient)
  // If target is explicitly marked as buffer or binaryString, read as buffer
  if (typeof target === 'string') {
    if (options.type === 'binaryString') {
      // Convert binary string to Buffer
      _target = Buffer.from(target, 'binary')
    } else if (options.type === 'buffer') {
      // Should already be a Buffer, but handle edge case
      _target = Buffer.from(target, 'binary')
    } else if (options.type === 'path' || fs.existsSync(target)) {
      // Pass file path directly to AdmZip - it handles file reading internally
      _target = target
    } else {
      // Fallback: treat as binary string
      _target = Buffer.from(target, 'binary')
    }
  }
  // If target is already a Buffer, use it directly

  return new Epub(_target, options).parse()
}
