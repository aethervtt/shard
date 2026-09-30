// @aethervtt/shard-dice (0054): dice as a first-party package. Definitions and their numbering,
// face layouts baked into MSDF atlases, skins over material families, physical tracks recorded
// in a worker (0053), landing on the host's result by a symmetry of the die, and presentation:
// phases, dropped dice, reduced motion, quality tiers, effects, cancellation and cleanup.

export {
  allDiceAttachments,
  type DiceAttachmentContext,
  type DiceAttachmentDef,
  defineDiceAttachment,
  findDiceAttachment,
  MAX_ATTACHMENT_VERTICES,
  MAX_ATTACHMENTS,
} from './attachments'
export {
  BUILTIN_DICE,
  D4,
  D6,
  D8,
  D10,
  D10_TENS,
  D12,
  D20,
  D100_BALL,
  DIE_KINDS,
  type DieKind,
  KIND_DEFINITIONS,
  kindSides,
  percentileValues,
  registerBuiltinDice,
} from './builtins'
export { CELL_PAD, type CellLayout, cellLayout, type FaceCell, MARK_RANGE } from './cells'
export { DiceDie, DiceRollRequest } from './components'
export {
  allDice,
  type DieDefinition,
  type DieGeometry,
  defineDie,
  dieGeometry,
  dieHash,
  findDie,
  frameOf,
  labelOf,
  physicalScale,
  requireDie,
  type ValueFrame,
  validateDieDefinition,
} from './definition'
export {
  DieDefinitionAsset,
  type DieDefinitionAssetValue,
  dieDefinitionOf,
} from './definition-asset'
export {
  type DiceCondition,
  type DiceEffect,
  DiceEffectRecipe,
  type DiceEffectRecipeValue,
  diceEffectRecipe,
  type MatchedRecipe,
  matchRecipes,
  RECIPE_LIMITS,
  recipeProblems,
} from './effects'
export { BUILTIN_FAMILIES, GLASS, METAL, RESIN, SOLID } from './families'
export {
  allDiceGlyphs,
  BUILTIN_GLYPHS,
  type DiceGlyph,
  type DiceGlyphDef,
  defineDiceGlyph,
  findDiceGlyph,
  parseSvgPath,
  registerBuiltinGlyphs,
} from './glyphs'
export {
  landingCorrection,
  markAngle,
  naturalValue,
  restingHeight,
  restRotation,
  topAlignment,
} from './landing'
export {
  ambiguousLabel,
  defaultLayoutFor,
  FaceLayout,
  type FaceLayoutValue,
  type FaceMark,
  layoutProblems,
  NUMBERS_LAYOUT,
  PIPS_LAYOUT,
  type ResolvedMark,
  resolveMark,
} from './layout'
export {
  type BakeMarksOptions,
  bakeMarks,
  clearMarkCache,
  MARK_MARGIN,
  type MarkAtlas,
  markAtlasKey,
  markPlacements,
  type Placement as MarkPlacement,
} from './marks'
export {
  allDiceFamilies,
  DICE_FIELDS,
  DICE_SHADERS,
  type DiceFamily,
  type DiceFamilyOptions,
  defineDiceFamily,
  findDiceFamily,
  isDiceMaterial,
} from './material'
export { dieMesh, floorQuad } from './mesh'
export { diceMethods } from './methods'
export { NUMERAL_HEIGHT } from './numerals'
export { type DicePluginOptions, dicePlugin, TOP_DOWN } from './plugin'
export { type DiceThumbnail, type DiceThumbnailOptions, renderDiceThumbnail } from './preview'
export { type DiceQuality, type DiceQualityChoice, resolveDiceQuality } from './quality'
export {
  type DiceLookKey,
  type DiceResourceEntry,
  DiceResources,
  RELEASE_AFTER_MS,
} from './resources'
export {
  type DiceQualityPreference,
  type DiceRoll,
  type DiceRollDie,
  expandRoll,
  type PhysicalDie,
  presentationScale,
  rollTrackRequest,
  viewportTray,
} from './roll'
export {
  BALL_DAMPING,
  DICE_CLEANUP_STEP,
  DICE_GROUPS,
  DICE_SETTLE_RULE,
  type DiceSettleParams,
  type DiceTray,
  diceSettle,
  outsideTray,
  restingFlat,
} from './settle'
export {
  BUILTIN_SKINS,
  DICE_SKINS,
  DiceSkin,
  type DiceSkinValue,
  type DiceSkinVariant,
  diceSkin,
  IMPACT_SOUNDS,
  type ImpactSound,
  MAX_SKIN_EFFECTS,
  type SkinContext,
  skinVariant,
  validateDiceSkin,
} from './skin'
export {
  ACCENT_CUES,
  type AccentCue,
  accentSamples,
  DiceSoundBank,
  IMPACT_LAYERS,
  IMPACT_VARIATIONS,
  impactLayer,
  impactSamples,
  impactStrength,
  wavBytes,
} from './sound'
export { studioEnvironment } from './studio'
export {
  ANIMATED_DEMAND,
  type DiceOutcome,
  type DicePhase,
  type DicePlayOptions,
  DiceTable,
  type DiceTableOptions,
  DiceTableState,
  PRESENTATION_DEMAND,
  PREVIEW_TRAY,
} from './table'
export {
  DICE_CONTACTS,
  DICE_GRAVITY,
  DICE_MAX_STEPS,
  DICE_STEP,
  type DiceTrackDie,
  type DiceTrackRequest,
  diceSettleParams,
  diceTrackScene,
  LAUNCH_EDGES,
  type LaunchEdge,
  laneLayout,
  launchEdgeOf,
  MAX_DICE,
  PLACED_DROP_STEPS,
  placeDie,
  placedFrom,
  placementSpots,
  seedOf,
  type UnlandedReason,
  unlandedDice,
} from './track'
export { DiceTray as DiceTrayMaterial, TRAY_SHADERS } from './tray'
