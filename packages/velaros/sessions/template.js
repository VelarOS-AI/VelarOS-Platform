// velaros:sessions 的代码模版：日常最常用的几种写法，一段一个函数。只是示例——按你的需要改写、只取其中几行都行，不必照着写。
// 对方看不到你们的对话：task、message 里把要做什么、做到哪一步、交回什么写清楚。ask 与 tell 只能在 execute 里调用。
import { ask, list, tell } from 'velaros:sessions'

// 在网页上下单：交给浏览器会话。已经有浏览器会话就交给它，没有就开一个（site 是先打开的网站）；付款之前让它停下来问。
async function placeOrder(item = '一包 A4 打印纸', site = 'https://www.jd.com') {
  const browser = (await list()).find((peer) => peer.workspace === 'browser' && !peer.self)
  const task = `在 ${site} 上买${item}：挑销量高、评价好的一款，数量 1，用默认收货地址下单；到付款那一步停下来问我，不要付款。交回商品名、价格和订单页地址。`
  const reply = browser ? await ask({ to: browser.id, task }) : await ask({ workspace: 'browser', site, task })
  // waiting：对方停下来问问题，answer 就是它的问题；答得上来就把答案写进 task，用 to 再交给它一次
  if (reply.status === 'waiting') return { session: reply.session, question: reply.answer }
  return { session: reply.session, status: reply.status, answer: reply.answer, reason: reply.reason }
}

// 对方停下来问的问题答得上来：把答案写进 task，用 to 交回给同一个会话，它接着做。
async function answerQuestion(session = 'browser-1', answer = '可以付款，用默认的支付方式。') {
  const reply = await ask({ to: session, task: `你刚才问的问题，答复是：${answer}照这个接着做完，交回订单号。` })
  return { status: reply.status, answer: reply.answer }
}

// 两件互不相干的事同时交出去：两个项目里各查一件事，一起等。已经有那个项目的会话就交给它，没有就开一个。
async function compareProjects(frontend = '/home/me/shop-web', backend = '/home/me/shop-api') {
  const peers = await list()
  const inProject = (root, task) => {
    const peer = peers.find((candidate) => candidate.workspace === 'project' && candidate.root === root)
    return peer ? ask({ to: peer.id, task }) : ask({ workspace: 'project', root, task })
  }
  const [web, api] = await Promise.all([
    inProject(frontend, '列出前端调用的订单接口：方法、路径、参数，交回一张 Markdown 表。'),
    inProject(backend, '列出后端实现的订单接口：方法、路径、参数，交回一张 Markdown 表。'),
  ])
  return { web: web.answer, api: api.answer }
}

// 给别的会话捎句话，不等它：闲着的马上收到，正在跑的这一轮跑完再收到（queued）。
async function notifyProjects(message = '订单接口的路径改成了 /api/v2/orders，后面的改动照新路径来。') {
  const peers = (await list()).filter((peer) => !peer.self && peer.workspace === 'project')
  return Promise.all(peers.map((peer) => tell({ to: peer.id, message })))
}
