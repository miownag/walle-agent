# 10 — RAG

## 设计原则

1. RAG 是纯插件，不内置到 core
2. 只定义接口，具体向量库实现由外部包提供
3. 通过 `collect_context` 事件注入检索结果
4. 内置一个简单的文件/本地检索器作为 fallback

---

## 实现备忘（与本规格的偏差）

`@walle-agent/rag` 落地时与早期 spec 文本有几处差异，记录在此：

1. **`loadDocs` 实际执行**：spec 在 `SimpleRAGPlugin.loadDocs` 留了
   "简化实现省略 glob 细节"。当前实现用 `fs.readdir(root, { recursive: true })`
   + 后缀匹配（patterns 里只取 `**/*.<ext>` 的扩展名做 suffix 过滤）。
   不引入 minimatch / glob 依赖；如果用户需要复杂 pattern，自己派生 `RAGPlugin`
   即可。

2. **`ingest` chunk id 用 `<docId>#<n>`**：spec 用 `crypto.randomUUID()` 给每个 chunk
   生成独立 id，会让用户无法通过原始文档 id 反查或删除。实现里改用
   `<docId>#<chunkIndex>`，配合 `delete([docId])` 同时删掉所有切片。

3. **`tokenize` 支持中文**：spec 用 `split(/\s+/)`，对中文文档完全失效。实现里
   用 `split(/[^a-z0-9_一-鿿]+/)`，至少能按汉字 / 数字 / 拉丁词元做粗粒度分词。
   这只影响内置 SimpleRAG 的关键词打分；外部向量插件不走这条路径。

4. **新增 `injectContext: false` 开关**：默认 `true`（自动注入到 prompt），
   `false` 时不订阅 `collect_context`，留给用户手动调用 `retrieve()`。
   方便和外部 RAG 共存或做实验对比。

5. **不存在的目录不报错**：spec 没说，实现里 `loadDocs` 遇到 `ENOENT` 直接返回空索引。
   常见用法是 docs 目录由 CI 生成，agent 启动时还没就位。

---

## RAG Plugin Interface

```ts
export interface RAGPlugin extends WallePlugin {
  name: string;

  /** 检索相关文档 */
  retrieve(request: RAGRetrieveRequest): Promise<RAGContext[]>;

  /** 可选：导入文档到知识库 */
  ingest?(documents: RAGDocument[]): Promise<void>;

  /** 可选：删除文档 */
  delete?(ids: string[]): Promise<void>;

  /** 可选：列出已有文档 */
  list?(): Promise<RAGDocumentInfo[]>;
}

export interface RAGRetrieveRequest {
  query: string;
  topK?: number;
  filters?: Record<string, unknown>;
  minScore?: number;
}

export interface RAGContext {
  id: string;
  content: string;
  score?: number;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface RAGDocument {
  id?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface RAGDocumentInfo {
  id: string;
  source?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}
```

---

## 基础 RAG Plugin 实现

内置一个简单的基于文件的 RAG 插件（不需要向量数据库）：

```ts
export interface SimpleRAGConfig {
  /** 知识库目录 */
  docsPath: string;
  /** 文件匹配模式 */
  patterns?: string[];
  /** 分块大小 */
  chunkSize?: number;
  /** 分块重叠 */
  chunkOverlap?: number;
}

export class SimpleRAGPlugin implements RAGPlugin {
  name = "simple-rag";

  private chunks: RAGChunk[] = [];

  constructor(private readonly config: SimpleRAGConfig) {}

  async install(ctx: AgentContext): Promise<void> {
    // 加载并分块文档
    await this.loadDocs();

    // 注册上下文收集
    ctx.events.on("collect_context", async ({ query, items }) => {
      const results = await this.retrieve({ query, topK: 5 });

      for (const result of results) {
        items.push({
          source: "rag",
          priority: 40 + (result.score ?? 0) * 30,
          content: `[Knowledge] ${result.content}\nSource: ${result.source ?? "unknown"}`,
          estimatedTokens: estimateTokens(result.content),
        });
      }
    });
  }

  async retrieve(request: RAGRetrieveRequest): Promise<RAGContext[]> {
    const queryWords = request.query.toLowerCase().split(/\s+/);

    const scored = this.chunks
      .map(chunk => {
        const words = chunk.content.toLowerCase().split(/\s+/);
        const hits = queryWords.filter(qw => words.some(w => w.includes(qw))).length;
        const score = hits / queryWords.length;
        return { chunk, score };
      })
      .filter(x => x.score > (request.minScore ?? 0.1))
      .sort((a, b) => b.score - a.score)
      .slice(0, request.topK ?? 5);

    return scored.map(({ chunk, score }) => ({
      id: chunk.id,
      content: chunk.content,
      score,
      source: chunk.source,
      metadata: chunk.metadata,
    }));
  }

  async ingest(documents: RAGDocument[]): Promise<void> {
    for (const doc of documents) {
      const chunks = this.splitIntoChunks(doc.content);
      for (const content of chunks) {
        this.chunks.push({
          id: crypto.randomUUID(),
          content,
          source: doc.metadata?.source as string,
          metadata: doc.metadata,
        });
      }
    }
  }

  private async loadDocs(): Promise<void> {
    const patterns = this.config.patterns ?? ["**/*.md", "**/*.txt"];
    // 使用 glob 加载文件并分块
    // 简化实现省略 glob 细节
  }

  private splitIntoChunks(text: string): string[] {
    const size = this.config.chunkSize ?? 500;
    const overlap = this.config.chunkOverlap ?? 100;
    const chunks: string[] = [];

    for (let i = 0; i < text.length; i += size - overlap) {
      chunks.push(text.slice(i, i + size));
    }

    return chunks;
  }
}

interface RAGChunk {
  id: string;
  content: string;
  source?: string;
  metadata?: Record<string, unknown>;
}
```

---

## 外部 RAG 插件示例

### Qdrant 插件

```ts
// @walle-agent/rag-qdrant (独立包)

export class QdrantRAGPlugin implements RAGPlugin {
  name = "qdrant-rag";

  constructor(private readonly options: {
    url: string;
    collection: string;
    embedder: LLMProvider; // 需要有 embeddings() 方法
    apiKey?: string;
  }) {}

  async install(ctx: AgentContext): Promise<void> {
    ctx.events.on("collect_context", async ({ query, items }) => {
      const results = await this.retrieve({ query });
      for (const r of results) {
        items.push({
          source: "rag:qdrant",
          priority: 40 + (r.score ?? 0) * 30,
          content: r.content,
        });
      }
    });
  }

  async retrieve(request: RAGRetrieveRequest): Promise<RAGContext[]> {
    const [vector] = await this.options.embedder.embeddings!([request.query]);

    const response = await fetch(`${this.options.url}/collections/${this.options.collection}/points/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.options.apiKey ? { "api-key": this.options.apiKey } : {}),
      },
      body: JSON.stringify({
        vector,
        limit: request.topK ?? 5,
        with_payload: true,
      }),
    });

    const data = await response.json();
    return data.result.map((hit: any) => ({
      id: String(hit.id),
      content: hit.payload.content,
      score: hit.score,
      source: hit.payload.source,
      metadata: hit.payload,
    }));
  }
}
```

---

## 使用示例

```ts
import { Agent } from "@walle-agent/core";
import { OpenAIProvider } from "@walle-agent/openai";
import { SimpleRAGPlugin } from "@walle-agent/rag";

const agent = await Agent.create({
  name: "RAG-Agent",
  model: new OpenAIProvider({ model: "gpt-4.1" }),
  plugins: [
    new SimpleRAGPlugin({
      docsPath: "./knowledge-base",
      patterns: ["**/*.md"],
      chunkSize: 800,
    }),
  ],
});

const result = await agent.run("项目的部署流程是什么？");
```
