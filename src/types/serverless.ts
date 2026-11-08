/** Draft planning only. No endpoint, worker, job, or charge is created. */
export interface QueueProfile {
  id: string;
  name: string;
  model: string;
  gpu_memory_gb: number;
  disk_gb: number;
  limits: { max_workers: 1; idle_timeout_seconds: number; execution_timeout_seconds: number };
  /** Unknown; null never means free. */
  pricing: null;
}
export interface QueueCatalog {
  stage: "draft_preview";
  runtime_available: false;
  creation_available: boolean;
  profiles: QueueProfile[];
  unsupported: string[];
}
export interface QueueDeployment {
  id: string;
  name: string;
  status: "draft";
  profile_id: string;
  profile_name: string;
  model: string;
  created_at: string;
  updated_at: string;
}
export interface QueueDeploymentList { data: QueueDeployment[] }
export interface QueueRequestParams { org_id?: string }
export interface QueueDeploymentCreateParams extends QueueRequestParams {
  name: string;
  profile_id: string;
  /** Persist this UUID to explicitly retry the same draft after a lost response. */
  client_request_id?: string;
}
