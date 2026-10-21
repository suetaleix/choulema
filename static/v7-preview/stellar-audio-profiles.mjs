// Original tonal palettes for the skin preview. No sampled audio assets.
export const DEFAULT_SOUND_STYLE='aurora';
export const SOUND_STYLES={
 aurora:{name:'星海空灵',tag:'推荐',character:'柔和 · 舒展 · 空间感',description:'缓慢铺开的星海和声，像光轻轻浮起来。',pad:[196,293.66],padGain:.034,notes:[392,493.88,587.33,493.88],reveal:[392,493.88,587.33],interval:.78,duration:.85,level:.071,attack:.07,partial:0,tail:1.15},
 crystal:{name:'琉璃星铃',tag:'清透',character:'晶莹 · 轻盈 · 明亮',description:'疏落的玻璃星铃，揭晓时绽开一束清光。',pad:[261.63,392],padGain:.017,notes:[523.25,659.25,783.99,659.25,587.33],reveal:[523.25,659.25,783.99],interval:.50,duration:.66,level:.080,attack:.018,partial:.09,tail:1.05},
 orbit:{name:'深空脉冲',tag:'科幻',character:'温暖 · 节奏 · 未来感',description:'圆润的电子脉冲，在深空里有序地呼吸。',pad:[164.81,246.94],padGain:.027,notes:[329.63,246.94,329.63,369.99],reveal:[329.63,415.30,493.88],interval:.64,duration:.38,level:.088,attack:.045,partial:.06,tail:.95},
 stream:{name:'星泉流光',tag:'流水',character:'水滴 · 涟漪 · 流动感',description:'水滴轻落星泉，柔和涟漪随星光缓缓流动。',pad:[196,392],padGain:.018,notes:[659.25,493.88,587.33,392,523.25],reveal:[392,523.25,659.25],interval:.62,duration:.72,level:.078,attack:.028,partial:0,glide:1.32,tail:1.18}
};
export const validSoundStyle=value=>Object.hasOwn(SOUND_STYLES,value)?value:DEFAULT_SOUND_STYLE;
// Machine actions lead; the selected space palette only decorates them.
export const MACHINE_SOUND_PROFILES={
 capsule:{label:'胶囊滚动 · 轻碰出仓 · 开壳',pad:130.81,padGain:.023,notes:[235,302,268,328,246],interval:.24,duration:.115,level:.068,attack:.013,glide:1.08},
 wheel:{label:'转盘过格 · 减速停稳 · 落点',pad:164.81,padGain:.020,notes:[640,615],interval:.16,duration:.064,level:.048,attack:.007,glide:1.03},
 sphere:{label:'星球旋转 · 空间流动 · 姓名飞出',pad:196,padGain:.032,notes:[392,493.88,587.33],interval:1.10,duration:1.05,level:.055,attack:.12,glide:1}
};
