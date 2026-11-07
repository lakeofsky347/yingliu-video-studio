export type FilmKind = 'general' | 'suspense_short' | 'product' | 'explainer' | 'lyrical';
export type AudioStrategy = 'native' | 'external' | 'silent';
export type ReferencePurpose = 'identity' | 'style' | 'world_layout' | 'blocking' | 'camera' | 'motion';
export interface DirectorCharacter { id:string; name:string; identity:string; objective?:string; baselineEmotion?:string }
export interface StoryBeat { id:string; function:string; change:string; shotIds:string[] }
/** World coordinates, screen coordinates and relational descriptions are deliberately separate. */
export interface WorldLayout { id:string; description:string; anchors:{id:string;position:[number,number,number]}[] }
export interface IdentityBinding { characterId:string; assetId:string }
export interface DirectorReference { assetId:string; purpose:ReferencePurpose; usage:'reference_only' }
export interface PerformanceBeat {
  id:string; characterId:string; start:number; end:number; objective:string; trigger?:string;
  emotionFrom?:string; emotionTo?:string; visibleAction:string; gaze?:string; body?:string;
  voice?:string; breath?:string; pauseSeconds?:number; endState?:string; forbiddenReactions?:string[];
  /** Optional experiment; never required or advertised as portable muscle control. */
  actionUnits?:{code:string;description:string;intensity?:number}[];
}
export interface DialogueEvent {
  id:string; characterId:string; start:number; end:number; text:string;
  delivery?:string; cue?:string; listenerReaction?:string;
  intentional?:{truncation?:boolean;repetition?:boolean;overlapWith?:string[]};
}
export interface ShotEvent {
  id:string; start:number; end:number; segmentId:string; worldLayoutId?:string;
  camera:string; screenPositions:{characterId:string;x:number;y:number;facing?:string}[];
  relationships?:{from:string;to:string;relation:string}[]; action:string;
}
export interface AcceptanceCondition {
  id:string; category:'visual'|'identity'|'space'|'timing'|'dialogue'|'audio';
  description:string; severity:'hard'|'advisory';
}
export interface DirectorShot {
  shotId:string; title:string; visualPrompt:string; durationSeconds:number; narration:string;
  audioStrategy:AudioStrategy; performance:PerformanceBeat[]; dialogue:DialogueEvent[];
  events:ShotEvent[]; references:DirectorReference[]; acceptance:AcceptanceCondition[];
}
export interface DirectorPlan {
  version:1; ruleSetVersion:string; filmKind:FilmKind; characters:DirectorCharacter[];
  storyBeats:StoryBeat[]; worldLayouts:WorldLayout[]; identityMap:IdentityBinding[]; shots:DirectorShot[];
}
export interface DirectorIssue { code:string; path:string; message:string; severity:'error'|'warning' }
export interface DirectorValidation { ok:boolean; errors:string[]; issues:DirectorIssue[]; plan?:DirectorPlan }
export interface DirectorRule {
  id:string; version:1; title:string; source:{url:string;range:string}[];
  applicability:string; requirement:string; failureCategories:string[];
  origin:'tutorial'|'engineering';
}
export interface QualityEvidence { kind:'structural'|'frame'|'audio'|'video'|'human'; frame?:number; timeSeconds?:number; sha256?:string; note?:string }
export interface QualityCheck {
  id:string; shotId?:string; category:string; severity:'hard'|'advisory';
  status:'pass'|'fail'|'unchecked'|'needs-review'; message:string; confidence?:number; evidence?:QualityEvidence[];
}
export interface QualityReport { version:1; candidateHash:string; decision:'pass'|'fail'|'needs-review'; checks:QualityCheck[] }
export interface TrustedReview { candidateHash:string; checkIds:string[] }
