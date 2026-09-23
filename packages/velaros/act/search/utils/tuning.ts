

/** 搜索活动的缺省调节参数。 */
export const SearchTuning = Object.freeze({
    /** 每个已读证据在常驻目录内显示的最大摘录字符数。 */
    contextExcerptChars:1200,
    /** 候选预览仅帮助选择读取目标。 */
    candidatePreviewChars:240,
    /** 有未读候选时为其预留目录空间，避免已读项占满。 */
    evidenceContextShare:0.7,
    /** 搜索发布结果的默认预留毫秒数。 */
    publicationMs: 1000,
    /** 刷新已选证据的默认数量。 */
    refreshItems: 8,
    /** 搜索重复且无进展的默认轮数。 */
    noProgressRounds: 3,
});
