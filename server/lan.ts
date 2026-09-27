// 发布产物拒绝缺少部署配置的启动，避免误读开发机 .env.local 或落入演示模式。
if (process.env.WRJ_DEPLOYMENT !== 'lan') throw new Error('内网发布入口必须设置 WRJ_DEPLOYMENT=lan。')
await import('./local.js')
export {}
