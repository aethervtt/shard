export interface Point {
  x: number
  y: number
}
export interface SceneGrid {
  type: 'square' | 'hex' | 'none'
  hexOrientation: 'pointy' | 'flat'
  size: number
  offset: Point
  distance: number
  unit: string
  diagonal: 'euclidean' | 'equal' | 'alternating'
}
export interface MaterialDoc {
  id: string
  rev: number
  name: string
  tint: string
  roughness: number
}
export interface WallDoc {
  id: string
  rev: number
  runId: string
  a: Point
  b: Point
  height: number
  thickness: number
  elevation: number
  materialId: string
}
export interface OpeningDoc {
  id: string
  rev: number
  kind: 'door' | 'window'
  hostWallId: string
  offset: number
  width: number
  height: number
  sill: number
  frameWidth: number
  frameDepth: number
  frameMaterialId: string | null
  hinge?: 'start' | 'end'
  swing?: 'left' | 'right'
  state?: 'closed' | 'open' | 'locked'
  sight: 'none' | 'normal'
  movement: 'none' | 'normal'
}
export interface FloorDoc {
  id: string
  rev: number
  name: string
  points: Point[]
  elevation: number
  surface: { kind: 'material'; materialId: string } | { kind: 'background' }
}
export interface PropDoc {
  id: string
  rev: number
  asset: string
  x: number
  y: number
  /** Size in grid cells. */
  cells: number
  rotation: number
}
export interface TokenDoc {
  id: string
  rev: number
  name: string
  x: number
  y: number
  /** Footprint in grid cells. */
  size: number
}
export interface SceneDocs {
  grid: SceneGrid
  materials: MaterialDoc[]
  walls: WallDoc[]
  openings: OpeningDoc[]
  floors: FloorDoc[]
  props: PropDoc[]
  tokens: TokenDoc[]
}
export declare const LIMITS: {
  walls: number
  openings: number
  floors: number
  floorVertices: number
  materials: number
  props: number
  propAssets: number
  propTriangles: number
}
export declare function shadowStress(seed?: number): SceneDocs
export declare function maxScene(seed?: number): SceneDocs
