// 门面:远程能力节点的产品装配面。
//
// 宿主只 import 本子路径与 `../contracts`(薄壳可拆铁律①)。连接生命周期、命名空间化与清单
// 投影全在包内;宿主提供的只有三样端口——凭据存储(safeStorage 之类)、工具面 sink、以及
// 「本 mod 是否已启用」的门控谓词。
export * from './RemoteHostService'
export * from './remote-tool'
