// New IDs prevent a preference for an earlier recording approving its replacement.
export const THEME_CHOICES={default:['slot-default1','slot-default2','slot-default3'],cosmic:['slot-cosmic1','slot-cosmic2','slot-cosmic3']};
export const validThemeChoice=(theme,value)=>Object.hasOwn(THEME_CHOICES,theme)&&THEME_CHOICES[theme].includes(value)?value:'';
export const sanitizeThemeChoices=value=>({default:validThemeChoice('default',value?.default),cosmic:validThemeChoice('cosmic',value?.cosmic)});
