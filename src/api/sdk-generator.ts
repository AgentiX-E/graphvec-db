/**
 * sdk-generator.ts — OpenAPI → SDK 客户端代码生成
 *
 * 利用 @hey-api/openapi-ts 从 OpenAPI 规范自动生成 TypeScript 客户端 SDK。
 * 同时提供自定义的轻量级 SDK 构建器，支持运行时动态生成。
 *
 * GAP-10: 多语言 SDK + 部署工具链
 */

import { execSync } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import { generateOpenAPIDocument, OpenAPIDocument } from './openapi-docs'

// ──────────────────────────────────────────
// 生成配置
// ──────────────────────────────────────────

export interface SdkGeneratorOptions {
  /** OpenAPI spec 输入路径（文件/URL），默认使用内置生成的 spec */
  input?: string
  /** 输出目录 */
  output: string
  /** HTTP 客户端类型：'fetch' | 'axios' | 'node' */
  client?: 'fetch' | 'node'
  /** 是否生成 ESM 模块 */
  esm?: boolean
  /** 命名空间/包名 */
  name?: string
  /** 生成语言目标：'typescript' | 'python' | 'go'（其他语言需自定义模板） */
  target?: 'typescript' | 'python' | 'go'
  /** 自定义 OpenAPI 文档（如果未提供 input 则使用此文档） */
  document?: OpenAPIDocument
  /** 输出服务端基础 URL */
  baseUrl?: string
  /** 是否在生成后清理临时文件 */
  cleanup?: boolean
}

export interface SdkGenerationResult {
  /** 输出目录 */
  outputDir: string
  /** 生成的文件列表 */
  files: string[]
  /** 耗时 ms */
  durationMs: number
  /** 生成语言 */
  target: string
  /** 是否成功 */
  success: boolean
  /** ErrorInfo（如果失败） */
  error?: string
}

// ──────────────────────────────────────────
// SDK 生成器
// ──────────────────────────────────────────

/**
 * 从 OpenAPI 规范生成 SDK 客户端代码
 *
 * 使用 @hey-api/openapi-ts 工具进行代码生成。
 * 支持 TypeScript (fetch/node) 目标。
 *
 * @param options 生成配置
 * @returns 生成结果
 */
export function generateSdk(options: SdkGeneratorOptions): SdkGenerationResult {
  const startTime = Date.now()
  const target = options.target || 'typescript'

  try {
    // 确保输出目录存在
    fs.mkdirSync(options.output, { recursive: true })

    // 准备 OpenAPI spec 文件
    let specPath: string
    let cleanupPaths: string[] = []
    const doc = options.document || generateOpenAPIDocument()

    if (options.input) {
      // 使用用户提供的 spec 路径
      specPath = options.input
    } else {
      // 生成 spec 到临时文件
      const tmpDir = path.join(options.output, '.tmp-spec')
      fs.mkdirSync(tmpDir, { recursive: true })
      specPath = path.join(tmpDir, 'openapi.json')
      fs.writeFileSync(specPath, JSON.stringify(doc, null, 2), 'utf-8')
      cleanupPaths.push(tmpDir)
    }

    // 构建 openapi-ts 命令
    const outputDir = path.resolve(options.output)
    const client = options.client || 'fetch'

    // 根据目标语言调用不同的生成策略
    if (target === 'typescript') {
      const cmd = [
        'npx',
        'openapi-ts',
        `-i "${specPath}"`,
        `-o "${outputDir}"`,
        `-c ${client}`,
        '--no-log-file',
      ].join(' ')

      execSync(cmd, {
        stdio: 'pipe',
        timeout: 60000,
        cwd: process.cwd(),
      })
    } else {
      // Python / Go — 使用自定义模板生成
      generateCustomSdk(doc, options)
    }

    // 收集生成的文件列表
    const files = collectFiles(outputDir)

    // 清理临时文件
    if (options.cleanup !== false) {
      for (const p of cleanupPaths) {
        rmRecursive(p)
      }
    }

    return {
      outputDir: outputDir,
      files,
      durationMs: Date.now() - startTime,
      target,
      success: true,
    }
  } catch (err) {
    return {
      outputDir: options.output,
      files: [],
      durationMs: Date.now() - startTime,
      target,
      success: false,
      error: (err as Error).message,
    }
  }
}

/**
 * 使用内置模板生成自定义 SDK（Python / Go）
 * 当 openapi-ts 不支持目标语言时使用
 */
function generateCustomSdk(doc: OpenAPIDocument, options: SdkGeneratorOptions): void {
  const outputDir = path.resolve(options.output)

  if (options.target === 'python') {
    generatePythonSdk(doc, outputDir, options)
  } else if (options.target === 'go') {
    generateGoClient(doc, outputDir, options)
  }
}

/**
 * 生成 Python SDK 代码
 */
function generatePythonSdk(doc: OpenAPIDocument, outputDir: string, options: SdkGeneratorOptions): void {
  const baseUrl = options.baseUrl || 'http://localhost:3000'
  let lines: string[] = [
    '"""',
    'AgentiX GraphVec Python SDK — Auto-generated from OpenAPI spec',
    `Base URL: ${baseUrl}`,
    '"""',
    'import json',
    'import urllib.request',
    'from typing import Any, Optional',
    '',
    '',
    'class AgentiXClient:',
    '    """GraphVec REST API Client"""',
    '',
    `    BASE_URL = "${baseUrl}"`,
    '',
    '    def __init__(self, base_url: Optional[str] = None, token: Optional[str] = None):',
    '        self.base_url = base_url or self.BASE_URL',
    '        self.token = token',
    '        self._headers = {"Content-Type": "application/json"}',
    '        if token:',
    '            self._headers["Authorization"] = f"Bearer {token}"',
    '',
    '    def _request(self, method: str, path: str, data: Any = None) -> Any:',
    '        url = f"{self.base_url}{path}"',
    '        body = json.dumps(data).encode("utf-8") if data else None',
    '        req = urllib.request.Request(url, data=body, headers=self._headers, method=method)',
    '        with urllib.request.urlopen(req) as resp:',
    '            return json.loads(resp.read().decode("utf-8"))',
    '',
    '    def health_check(self) -> dict:',
    '        """Check service health"""',
    '        return self._request("GET", "/api/health")',
    '',
    '    def graph_query(self, db: str, query: str, params: Optional[dict] = None) -> dict:',
    '        """Execute graph query"""',
    '        payload = {"query": query}',
    '        if params:',
    '            payload["params"] = params',
    '        return self._request("POST", f"/api/v1/{db}/graph-query", payload)',
    '',
    '    def get_node(self, db: str, node_id: int) -> dict:',
    '        """Get node by ID"""',
    '        return self._request("GET", f"/api/v1/{db}/node?id={node_id}")',
    '',
    '    def create_node(self, db: str, name: str, node_type: int = 0, props: Optional[dict] = None) -> dict:',
    '        """Create a new node"""',
    '        payload = {"name": name, "type": node_type}',
    '        if props:',
    '            payload["props"] = props',
    '        return self._request("POST", f"/api/v1/{db}/node", payload)',
    '',
    '    def update_node(self, db: str, node_id: int, name: Optional[str] = None, props: Optional[dict] = None) -> dict:',
    '        """Update an existing node"""',
    '        payload = {}',
    '        if name:',
    '            payload["name"] = name',
    '        if props:',
    '            payload["props"] = props',
    '        return self._request("PUT", f"/api/v1/{db}/node?id={node_id}", payload)',
    '',
    '    def delete_node(self, db: str, node_id: int) -> dict:',
    '        """Delete a node"""',
    '        return self._request("DELETE", f"/api/v1/{db}/node?id={node_id}")',
    '',
    '    def create_edge(self, db: str, src: int, dst: int, edge_type: int, props: Optional[dict] = None) -> dict:',
    '        """Create a new edge"""',
    '        payload = {"src": src, "dst": dst, "type": edge_type}',
    '        if props:',
    '            payload["props"] = props',
    '        return self._request("POST", f"/api/v1/{db}/edge", payload)',
    '',
    '    def get_edge(self, db: str, src: int, dst: int, edge_type: int) -> dict:',
    '        """Get edge by src/dst/type"""',
    '        return self._request("GET", f"/api/v1/{db}/edge?src={src}&dst={dst}&type={edge_type}")',
    '',
    '    def delete_edge(self, db: str, src: int, dst: int, edge_type: int) -> dict:',
    '        """Delete an edge"""',
    '        return self._request("DELETE", f"/api/v1/{db}/edge?src={src}&dst={dst}&type={edge_type}")',
  ];

  fs.writeFileSync(path.join(outputDir, 'agentix_client.py'), lines.join('\n'), 'utf-8')
}

/**
 * 生成 Go SDK 代码
 */
function generateGoClient(doc: OpenAPIDocument, outputDir: string, options: SdkGeneratorOptions): void {
  const baseUrl = options.baseUrl || 'http://localhost:3000'
  const lines: string[] = [
    'package agentix',
    '',
    'import (',
    '	"bytes"',
    '	"encoding/json"',
    '	"fmt"',
    '	"io"',
    '	"net/http"',
    '	"strconv"',
    ')',
    '',
    '// AgentiXClient — GraphVec REST API Client',
    'type Client struct {',
    '	BaseURL    string',
    '	HTTPClient *http.Client',
    '	Token      string',
    '}',
    '',
    '// NewClient creates a new GraphVec API client',
    'func NewClient(baseURL, token string) *Client {',
    '	return &Client{',
    `		BaseURL:    "${baseUrl}",`,
    '		HTTPClient: &http.Client{},',
    '		Token:      token,',
    '	}',
    '}',
    '',
    'func (c *Client) doRequest(method, path string, body interface{}) ([]byte, error) {',
    '	var reqBody io.Reader',
    '	if body != nil {',
    '		data, err := json.Marshal(body)',
    '		if err != nil {',
    '			return nil, err',
    '		}',
    '		reqBody = bytes.NewReader(data)',
    '	}',
    '	url := c.BaseURL + path',
    '	req, err := http.NewRequest(method, url, reqBody)',
    '	if err != nil {',
    '		return nil, err',
    '	}',
    '	req.Header.Set("Content-Type", "application/json")',
    '	if c.Token != "" {',
    '		req.Header.Set("Authorization", "Bearer "+c.Token)',
    '	}',
    '	resp, err := c.HTTPClient.Do(req)',
    '	if err != nil {',
    '		return nil, err',
    '	}',
    '	defer resp.Body.Close()',
    '	return io.ReadAll(resp.Body)',
    '}',
    '',
    '// HealthCheck checks service health',
    'func (c *Client) HealthCheck() (map[string]interface{}, error) {',
    '	data, err := c.doRequest("GET", "/api/health", nil)',
    '	if err != nil {',
    '		return nil, err',
    '	}',
    '	var result map[string]interface{}',
    '	if err := json.Unmarshal(data, &result); err != nil {',
    '		return nil, err',
    '	}',
    '	return result, nil',
    '}',
    '',
    'type NodeCreateRequest struct {',
    '	Name  string                 `json:"name"`',
    '	Type  int                    `json:"type,omitempty"`',
    '	Props map[string]interface{} `json:"props,omitempty"`',
    '}',
    '',
    '// CreateNode creates a new node',
    'func (c *Client) CreateNode(db, name string, nodeType int, props map[string]interface{}) (map[string]interface{}, error) {',
    '	body := NodeCreateRequest{Name: name, Type: nodeType, Props: props}',
    '	data, err := c.doRequest("POST", "/api/v1/" + db + "/node", body)',
    '	if err != nil {',
    '		return nil, err',
    '	}',
    '	var result map[string]interface{}',
    '	if err := json.Unmarshal(data, &result); err != nil {',
    '		return nil, err',
    '	}',
    '	return result, nil',
    '}',
    '',
    '// GetNode retrieves a node by ID',
    'func (c *Client) GetNode(db string, id int) (map[string]interface{}, error) {',
    '	path := fmt.Sprintf("/api/v1/%s/node?id=%s", db, strconv.Itoa(id))',
    '	data, err := c.doRequest("GET", path, nil)',
    '	if err != nil {',
    '		return nil, err',
    '	}',
    '	var result map[string]interface{}',
    '	if err := json.Unmarshal(data, &result); err != nil {',
    '		return nil, err',
    '	}',
    '	return result, nil',
    '}',
    '',
    '// DeleteNode deletes a node by ID',
    'func (c *Client) DeleteNode(db string, id int) (map[string]interface{}, error) {',
    '	path := fmt.Sprintf("/api/v1/%s/node?id=%s", db, strconv.Itoa(id))',
    '	data, err := c.doRequest("DELETE", path, nil)',
    '	if err != nil {',
    '		return nil, err',
    '	}',
    '	var result map[string]interface{}',
    '	if err := json.Unmarshal(data, &result); err != nil {',
    '		return nil, err',
    '	}',
    '	return result, nil',
    '}',
  ]

  fs.writeFileSync(path.join(outputDir, 'agentix_client.go'), lines.join('\n'), 'utf-8')
}

/**
 * 收集目录下的文件列表（递归）
 */
function collectFiles(dir: string): string[] {
  const files: string[] = []
  if (!fs.existsSync(dir)) return files

  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.')) {
        files.push(...collectFiles(fullPath))
      }
    } else {
      files.push(fullPath)
    }
  }
  return files
}

/**
 * 递归删除目录
 */
function rmRecursive(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// ──────────────────────────────────────────
// 运行时 SDK（轻量内嵌版本）
// ──────────────────────────────────────────

/**
 * 轻量级 API 客户端 — 运行时使用，无需代码生成
 * 提供与生成 SDK 相同的接口，直接调用 REST API。
 */
export class RuntimeApiClient {
  private baseUrl: string
  private token: string

  constructor(baseUrl: string, token?: string) {
    // Strip trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.token = token || ''
  }

  /**
   * 设置认证 token
   */
  setToken(token: string): void {
    this.token = token
  }

  /**
   * 发送 HTTP 请求
   */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`
    }

    const url = `${this.baseUrl}${path}`
    const options: RequestInit = {
      method,
      headers,
    }
    if (body !== undefined) {
      options.body = JSON.stringify(body)
    }

    const response = await fetch(url, options)
    if (!response.ok) {
      const errorBody = await response.text()
      throw new Error(`API error ${response.status}: ${errorBody}`)
    }
    return response.json() as Promise<T>
  }

  // ── Health ──

  async healthCheck(): Promise<{ status: string; uptime: number; version: string }> {
    return this.request('GET', '/api/health')
  }

  // ── Graph Query ──

  async graphQuery(db: string, query: string, params?: Record<string, unknown>): Promise<{ results: unknown[]; duration: number }> {
    return this.request('POST', `/api/v1/${encodeURIComponent(db)}/graph-query`, { query, params })
  }

  // ── Node CRUD ──

  async getNode(db: string, id: number): Promise<Record<string, unknown>> {
    return this.request('GET', `/api/v1/${encodeURIComponent(db)}/node?id=${id}`)
  }

  async createNode(db: string, name: string, nodeType?: number, props?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request('POST', `/api/v1/${encodeURIComponent(db)}/node`, { name, type: nodeType, props })
  }

  async updateNode(db: string, id: number, updates: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request('PUT', `/api/v1/${encodeURIComponent(db)}/node?id=${id}`, updates)
  }

  async deleteNode(db: string, id: number): Promise<{ deleted: boolean }> {
    return this.request('DELETE', `/api/v1/${encodeURIComponent(db)}/node?id=${id}`)
  }

  // ── Edge CRUD ──

  async getEdge(db: string, src: number, dst: number, type: number): Promise<Record<string, unknown>> {
    return this.request('GET', `/api/v1/${encodeURIComponent(db)}/edge?src=${src}&dst=${dst}&type=${type}`)
  }

  async createEdge(db: string, src: number, dst: number, type: number, props?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request('POST', `/api/v1/${encodeURIComponent(db)}/edge`, { src, dst, type, props })
  }

  async deleteEdge(db: string, src: number, dst: number, type: number): Promise<{ deleted: boolean }> {
    return this.request('DELETE', `/api/v1/${encodeURIComponent(db)}/edge?src=${src}&dst=${dst}&type=${type}`)
  }
}
