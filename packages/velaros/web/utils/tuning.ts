/**
 * 包内可调参数：超时、等渲染的时长、Google 搜不通之后退避多久、结果文字留多长。都是取舍，没有唯一正确的值；要调就改这一个文件，全单元跟着变。
 * 对外承诺的上限与缺省值不在这里，在 `contract/constants.ts`。
 */

/** web 单元的可调参数，按用途分组。 */
export const WebTuning = Object.freeze({
  /** 页面本身：开页面、在页面里跑脚本。 */
  page: Object.freeze({
    /** 等宿主开出一个不显示的页面最多多久，毫秒。 */
    openTimeoutMs: 10_000,
    /** 在页面里跑一段脚本最多等多久，毫秒；页面卡死时不陪它一直等。 */
    evaluateTimeoutMs: 10_000,
  }),
  /** 搜索。 */
  search: Object.freeze({
    /**
     * Google 搜不通之后，多久以内的搜索直接走 Bing，毫秒。
     * 国内常常打不开 Google，每次都先白等一轮不值；宿主给了退避记忆就跨重启记着，过了这段时间再试一次。
     */
    googleBackoffMs: 12 * 60 * 60_000,
    /**
     * Google 多久还没落下文档（服务器一个字节都没回来）就算打不开、换 Bing，毫秒。
     * 打得开的地方它半秒到一秒就落下；打不开的地方连接一直挂着，只有这一段要掐短。落下之后结果页慢慢出来，照 googleLoadTimeoutMs 等。
     */
    googleCommitMs: 4_500,
    /** 等 Google 结果页加载完最多多久，毫秒；到点还没加载完的，已经出来的结果照抓，不算没搜通。 */
    googleLoadTimeoutMs: 8_000,
    /** 等 Bing 结果页加载多久算超时，毫秒。 */
    bingLoadTimeoutMs: 15_000,
    /** 问宿主把 Google 的 /goto 跳转链接换成真实地址，一批最多等多久，毫秒；问不出来的原样留着。 */
    redirectTimeoutMs: 5_000,
    /** 在要的条数之外多整理几条原始结果备着：去重会丢掉几条，/goto 链接也只多问这几条。 */
    spareHits: 4,
    /** 认验证页时看结果页正文的前多少个字符。 */
    probeTextChars: 2_000,
    /** 一条结果的标题最多留多少个字符。 */
    titleChars: 300,
    /** 一条结果的摘要最多留多少个字符。 */
    snippetChars: 600,
  }),
  /** 读网页。 */
  read: Object.freeze({
    /** 等网页加载多久算超时，毫秒；到点还在加载的，已经出来的正文照读。 */
    loadTimeoutMs: 20_000,
    /** 加载完之后最多再等多久，让单页应用把内容渲染出来，毫秒。 */
    settleMs: 5_000,
    /** 正文长度多久不变算渲染完了，毫秒。 */
    stableMs: 700,
    /** 等渲染时隔多久看一次正文长度，毫秒。 */
    pollMs: 150,
    /** article、main 里的字占全页的比例到了这么多，就只读它、不读整页。 */
    mainShare: 0.5,
    /** 导航、页眉页脚、侧栏、表单这类块里的字占全页超过这个比例，就当它包着正文，不删。 */
    wrapperShare: 0.5,
  }),
})
