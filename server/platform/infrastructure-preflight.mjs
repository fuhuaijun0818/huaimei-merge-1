// Compatibility entry point for deployment tooling. The canonical module name
// is production-readiness.mjs.
export {
  assertProductionInfrastructure,
  createInfrastructurePreflight,
  createProductionReadiness,
  validateInfrastructureConfig
} from "./production-readiness.mjs";
