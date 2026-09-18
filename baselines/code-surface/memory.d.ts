declare module 'velar:memory' {
  /**
   * 长期记忆：跨会话记住用户的偏好、纠正、目标与稳定事实，以及对以后还有用的任务、项目、做法与产出。
   * 只在当前空间（当前项目、当前站点或系统空间）里读写，别的空间的看不到，拿别的空间的 id 也当作不存在。
   * 写之前想清楚：不要保存密码、Token、Cookie、私钥或恢复码；不要把没有证据的推断写成用户事实；只对当前回合有用的临时步骤不要存。
   * 你写下的内容作者是你，不是用户——不要声称「用户已确认」。召回到的记忆带着可信度与来源，不要当成无来源的绝对事实。
   */

  /**
   * 写一条：kind、title、content 必填，title 最多 240 个字符，content 最多 24000 个字符。
   * summary 是给人看的摘要，最多 1000 个字符；source、tags 只写进记忆文件给人看、不影响召回（source 最多 240 个字符，tags 最多 24 个、每个最多 80 个字符）；
   * taskKey 是任务的稳定键，最多 240 个字符。
   */
  interface MemorySaveInput {
    kind: MemoryKind
    title: string
    content: string
    summary?: string
    source?: string
    tags?: string[]
    taskKey?: string
  }

  /**
   * 写下了：memoryId 是这条的 id；inserted 为假是同一空间里类别、标题和正文都相同的已经记过，这次没多出一条（措辞变了就是新的一条）。
   * availability 说什么时候召回得到：immediate 现在就能，consolidating 由后台整理择时纳入——照这个说，不要凭空承诺「稍后整理」。
   * treeVersion 只有带整理管线的记忆库才有。
   */
  interface MemorySaved {
    memoryId: string
    inserted: boolean
    availability: 'immediate' | 'consolidating'
    treeVersion?: number
  }

  /**
   * 召回：有话题就给 query（用用户原话或关键词，最多 500 个字符）；不给就是看最近记了什么。
   * categories 只要这几类，只看用户画像就给 ['preference', 'feedback', 'interest']。deep 为真时连已归档的一起找，缺省只找在用的。
   * limit 要几条：有 query 时默认 10，没有时默认 20，最多 50。
   */
  interface MemorySearchInput {
    query?: string
    categories?: MemoryKind[]
    deep?: boolean
    limit?: number
  }

  /** 召回结果：memories 按相关度排好，每条带着记下的内容与来源。 */
  interface MemoryFound {
    query: string
    count: number
    memories: MemoryItem[]
  }

  /** 按 id 读或归档一条：id 来自 search 的结果，或环境里给的记忆 id。 */
  interface MemoryIdInput {
    id: string
  }

  /**
   * 一条记忆：value 是记下的内容（文件档是正文文字，树档可能是结构化的值），summary 是摘要。
   * confidence 是可信度（0 到 1）；sources 是它依据的证据 id，sourceTypes 是这些证据从哪来——agent_tool 是 agent 写的、chat_message 是用户在对话里说的，
   * 不要把 agent 写的当成用户确认过的。scopeType、scopeId 说它属于哪个空间；retrievalReason 说它是怎么被召回的
   * （text 话题命中、semantic 语义命中、scope 按空间列出、recent 最近写的、mainline 主线、deep 是 deep 召回翻出来的）；
   * path 是在记忆树上的位置，只有树档有。updatedAt 是毫秒时间戳。
   */
  interface MemoryItem {
    id: string
    title: string
    summary: string
    value: unknown
    conceptType: 'user' | 'project' | 'task' | 'goal' | 'interest' | 'procedure' | 'entity' | 'artifact' | 'conversation'
    predicate: string
    scopeType: 'global' | 'workspace' | 'site' | 'system' | 'session' | 'execution'
    scopeId: string
    confidence: number
    activation: number
    updatedAt: number
    retrievalReason: 'text' | 'scope' | 'mainline' | 'recent' | 'deep' | 'semantic'
    sources: string[]
    sourceTypes: string[]
    path?: Array<{ type: string; title: string }>
  }

  /**
   * 归档的结果：archived 为假就是没归档成（这条所在的记忆目录是只读的），要如实告诉用户，别说已经归档。
   * 归档不是删除：内容还在，deep 召回仍找得到；affectedEvidenceIds 是这次退出日常召回的证据。
   */
  interface MemoryArchived {
    archived: boolean
    affectedEvidenceIds: string[]
  }

  /**
   * 记忆类别：fact 稳定事实、preference 偏好、feedback 对协作方式的反馈、procedure 做法、project 项目、task 任务、
   * goal 目标、interest 兴趣、entity 人与事物、artifact 产出物、conversation 对话要点。
   */
  type MemoryKind = 'conversation' | 'fact' | 'preference' | 'feedback' | 'procedure' | 'project' | 'task' | 'goal' | 'interest' | 'entity' | 'artifact'

  /** 写一条长期记忆：用户明确表达的长期偏好、纠正、目标或稳定事实，或对以后还有用的任务、项目、做法与产出。 */
  export function save(input: MemorySaveInput): Promise<MemorySaved>

  /** 召回当前空间的长期记忆：回答依赖用户的历史、偏好、项目连续性或既有结论时先召回。 */
  export function search(input: MemorySearchInput): Promise<MemoryFound>

  /** 按 id 读一条记忆的内容与来源。 */
  export function get(input: MemoryIdInput): Promise<MemoryItem>

  /** 归档一条记忆，让它退出日常召回：用户明确说某条过时了、暂时不想它影响回答时用。不是删除；用户要彻底删除时如实说现在只能归档。 */
  export function archive(input: MemoryIdInput): Promise<MemoryArchived>
}
