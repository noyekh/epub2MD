import { NodeHtmlMarkdown } from 'node-html-markdown'

/**
 * Convert html to markdown
 */
const convert = (htmlString: string, options?: Parameters<typeof NodeHtmlMarkdown.translate>[1]) => NodeHtmlMarkdown.translate(htmlString, {
    useLinkReferenceDefinitions: false,
    ...options
})

export default convert as (htmlString: string) => string
