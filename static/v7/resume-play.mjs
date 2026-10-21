const applications = {food:'抽吃什么',play:'抽玩什么',prize:'抽奖品',person:'抽点名'};

// Only inspect the authenticated account's own draft, and build a fixed local URL.
export function resumePlay(raw, userId) {
  if (!Number.isSafeInteger(userId) || userId < 1) return null;
  try {
    const prefix = `clm-scope:user:${userId}:`;
    const app = JSON.parse(raw.getItem(prefix+'clm-app'));
    if (!Object.hasOwn(applications,app)) return null;
    const draft = JSON.parse(raw.getItem(prefix+'clm-drafts'))?.[app];
    if (!draft?.config || draft.config.app !== app) return null;
    return {app,label:applications[app],title:String(draft.config.title||applications[app]).slice(0,80),href:'/play.html?app='+app};
  } catch { return null; }
}
