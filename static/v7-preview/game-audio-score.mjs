export const CANDIDATES={
 a:{name:'欢乐街机',tag:'弹性 · 明快',description:'跳跃短音，清脆落点，像拿到一份小奖励。',process:'轻机械与木琴式短音',reward:'明亮上行，干净收尾',color:'#e6bb78'},
 b:{name:'机械游乐场',tag:'实体 · 爽快',description:'滚碰、棘轮与落锁，强化机台的实体手感。',process:'滚动质感与机械短击',reward:'扎实重音，短促庆祝',color:'#8ed9cd'},
 c:{name:'能量引擎',tag:'科幻 · 冲击',description:'能量逐步启动，在落点释放一段电子奖励。',process:'电子棘轮与上扬蓄势',reward:'能量重音，电子乐句',color:'#b4a3ff'},
 d:{name:'魔法水晶',tag:'水滴 · 轻奇幻',description:'水滴般的触点，晶体开裂后亮起一串奖励音。',process:'晶体短击与轻掠过',reward:'闪耀短句，涟漪余音',color:'#eeafcb'}
};
export const MACHINES={capsule:'胶囊机',wheel:'转盘',sphere:'姓名星球'};
export const validCandidate=v=>Object.hasOwn(CANDIDATES,v)?v:'a';
export const validMachine=v=>Object.hasOwn(MACHINES,v)?v:'capsule';
export function actionCue(machine,index=0){return machine==='capsule'?`capsule-hit-${index%3}`:machine==='wheel'?'wheel-tick':'sphere-pass';}
export const motionInterval=machine=>machine==='capsule'?.18:machine==='wheel'?.10:.48;
