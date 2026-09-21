

/** 根据已落盘事件生成的宿主展示，不拥有执行权。 */
export interface ActPresentation {
 readonly cursor:number
 readonly runs:Readonly<Record<string,{readonly status:string;readonly turnId?:string;readonly preview:string;readonly messages:ReadonlyArray<{readonly turnId:string;readonly text:string;readonly ref:{readonly sessionId:string;readonly id:string}}>;readonly errors:readonly string[]}>>
}
