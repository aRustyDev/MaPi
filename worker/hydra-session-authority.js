import { WorkerEntrypoint } from "cloudflare:workers";

const idPattern = /^[A-Za-z0-9_-]{1,128}$/;

// Grant identities are supplied only by the private Hydra service.
export class HydraSessionAuthority extends WorkerEntrypoint {
  async verify(identity) {
    try {
      if (!identity || typeof identity.projectId !== "string" || typeof identity.userId !== "string" ||
          typeof identity.sessionId !== "string" || !idPattern.test(identity.projectId) ||
          !idPattern.test(identity.userId) || !idPattern.test(identity.sessionId) || typeof identity.issuer !== "string") return false;
      const issuer = new URL(identity.issuer);
      if (issuer.protocol !== "https:" || issuer.username || issuer.password ||
          issuer.pathname !== `/oauth/${identity.projectId}` || issuer.search || issuer.hash) return false;
      const route = await this.env.PROJECT_REGISTRY.getByName("projects").resolve(issuer.origin);
      if (!route || route.state !== "active" || route.project_id !== identity.projectId ||
          route.origin !== issuer.origin) return false;
      const ownerRoute = {
        projectId: route.project_id, origin: route.origin,
        objectName: route.object_name, generation: route.generation,
      };
      return await this.env.NEXTGEN_APPLICATION.getByName(route.object_name).hydraSessionValid(identity, ownerRoute) === true;
    } catch {
      return false;
    }
  }
}
