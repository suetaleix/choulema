export const CANDIDATE_KEYS=['aurora','starlight','spring','moon'];
export const validChoice=value=>CANDIDATE_KEYS.includes(value)?value:'';
export const validMachine=value=>['capsule','wheel','sphere'].includes(value)?value:'capsule';
export function phaseAt(time,phases){
 if(!phases.length)return null;
 const value=Math.max(0,Number(time)||0);
 return phases.find(phase=>value>=phase.start&&value<phase.end)||phases[phases.length-1];
}
export const prepareReviewChoice=(defaultChoice,cosmicChoice)=>({default:validChoice(defaultChoice),cosmic:validChoice(cosmicChoice)});
