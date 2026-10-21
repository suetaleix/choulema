// Pure compatibility contract, also exercised with future-content fixtures.
export function appearanceProblem(catalog,config,availability=catalog){
 const m=catalog.machines[config.machine],t=catalog.themes[config.theme];
 if(!m||!t)return '机台或主题尚未交付，请刷新后选择可用内容';
 if(availability.machines?.[config.machine]?.enabled===false||availability.themes?.[config.theme]?.enabled===false)return '该机台或主题暂时维护中，请选择其他内容';
 if(!t.machines.includes(config.machine))return '当前主题不兼容所选机台';
 if(!m.modes.includes(config.mode)||config.count>m.max_count)return '该机台不支持当前人数或规则，请选择其他机台';
 if(config.items?.filter(i=>!i.excluded).length>m.max_items)return `${m.name}最多展示 ${m.max_items} 项，请切换其他机台`;
 if(config.sound&&!t.sounds.includes(config.sound))return '音效必须属于当前主题';
 return '';
}
export function accessProblem(catalog,config,features=[]){
 for(const item of [catalog.machines[config.machine],catalog.themes[config.theme]]){
  if(item?.feature&&!features.includes(item.feature))return `请先免费预览或开通${item.name}`;
 }
 return '';
}
export function capabilityAllowed(catalog,account,key){
 if(account.capabilities)return account.capabilities.includes(key);
 return catalog.capabilities[key]?.features.some(f=>account.features?.includes(f))||false;
}
