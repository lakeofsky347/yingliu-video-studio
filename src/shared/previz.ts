export type PrevizOutputMode = 'image' | 'video' | 'both';
export type PrevizPose = 'stand' | 'walk' | 'run' | 'sit' | 'point' | 'crouch';
export type PrevizLighting = 'three_point' | 'daylight' | 'noir_rim' | 'neon_night' | 'golden_hour';

export interface PrevizObjectSpec {
  id: string;
  kind: 'character' | 'box' | 'cylinder' | 'sphere' | 'plane';
  position: [number, number, number];
  /** Optional end position [x,y,z] for character/object blocking movement across the shot. */
  endPos?: [number, number, number];
  scale?: [number, number, number];
  height?: number;
  facingDeg?: number;
  /** Optional end yaw angle for turning characters. */
  endFacingDeg?: number;
  /** Articulated humanoid pose for character stand-ins. */
  pose?: PrevizPose;
  color?: string;
}
export interface PrevizCameraSpec {
  lensMm?: number;
  /** Optional Dutch tilt angle in degrees (-60 to 60). */
  rollDeg?: number;
  /** Optional aperture f-stop (e.g. 1.8, 2.8, 5.6) for depth of field. */
  fStop?: number;
  /** Optional focus distance in meters when fStop is set. */
  focusDistance?: number;
  startPos: [number, number, number];
  endPos?: [number, number, number];
  startTarget: [number, number, number];
  endTarget?: [number, number, number];
}
export interface PrevizSceneSpec {
  output?: PrevizOutputMode;
  /** Emit an object-distance matte alongside the whitebox keyframe (default true). */
  emitDepth?: boolean;
  width?: number;
  height?: number;
  fps?: number;
  durationSeconds?: number;
  engine?: 'BLENDER_WORKBENCH' | 'BLENDER_EEVEE_NEXT';
  lighting?: PrevizLighting;
  background?: string;
  camera: PrevizCameraSpec;
  objects: PrevizObjectSpec[];
}

export interface PrevizScope {
  shotId:string;
  documentVersion:number;
  documentHash:string;
}

export interface PrevizRecord extends PrevizScope {
  id:string;
  projectId:string;
  imageAssetId:string;
  depthAssetId?:string;
  videoAssetId?:string;
  mediaHashes:{main:string;original?:string}[];
  width:number;
  height:number;
  fps:number;
  frameCount:number;
  renderedAt:string;
  approvedAt?:string;
}

export interface PrevizStatus {
  scope:PrevizScope|null;
  record:PrevizRecord|null;
  rendering:boolean;
}

export function previzAssetIds(record:PrevizRecord):string[]{
  return [record.imageAssetId,record.depthAssetId,record.videoAssetId].filter((id):id is string=>!!id);
}
