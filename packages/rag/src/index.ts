/**
 * @walle-agent/rag — public API.
 *
 * `SimpleRAGPlugin` is a fallback file-keyword retriever. External vector
 * backends should implement the `RAGPlugin` interface from this package.
 */

export { SimpleRAGPlugin } from "./simple-rag-plugin.js";
export type {
  RAGPlugin,
  RAGRetrieveRequest,
  RAGContext,
  RAGDocument,
  RAGDocumentInfo,
  RAGChunk,
  SimpleRAGConfig,
} from "./rag-types.js";
