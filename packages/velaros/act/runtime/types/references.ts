

// 可移植形状与 ContextStorage 签发的引用及来源版本保持一致。
export type ContextRef={readonly sessionId:string;readonly id:string}
export type ContextTarget={readonly kind:'resource';readonly sourceId:string;readonly resourceId:string;readonly selector?:{readonly kind:'whole'}|{readonly kind:'lines';readonly start:number;readonly end:number}|{readonly kind:'symbol';readonly name:string}}|{readonly kind:'artifact';readonly ref:ContextRef}
export type ContextReadStamp={readonly sourceId:string;readonly resourceId:string;readonly revision:Nullable<string>;readonly contentHash:string;readonly observedAt:string;readonly consistency:'snapshot'|'revision-checkable'|'observed-only'}
export type ContextSourceHit={readonly target:ContextTarget;readonly preview:string;readonly forms:ReadonlyArray<'full'|'excerpt'|'definition'|'metadata'|'diff'>}
