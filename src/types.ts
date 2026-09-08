export type Context = 'view' | 'edit' | 'embed';

export type OutputFormat = 'table' | 'json' | 'csv' | 'yaml' | 'ids' | 'count' | 'raw';

export interface EndpointArgSchema {
  description?: string;
  type?: string | string[];
  enum?: string[];
  default?: unknown;
  required?: boolean;
  context?: string[];
  format?: string;
  properties?: Record<string, EndpointArgSchema>;
  readonly?: boolean;
  [key: string]: unknown;
}

export interface RouteEndpoint {
  methods: string[];
  args?: Record<string, EndpointArgSchema>;
  [key: string]: unknown;
}

export interface RouteSchema {
  namespace: string;
  methods: string[];
  endpoints: RouteEndpoint[];
  _links?: Record<string, Array<{ href: string }>>;
  [key: string]: unknown;
}

export interface IndexResponse {
  name?: string;
  description?: string;
  url?: string;
  home?: string;
  namespaces: string[];
  authentication?: {
    'application-passwords'?: {
      endpoints?: { authorization?: string };
    };
    [key: string]: unknown;
  };
  routes: Record<string, RouteSchema>;
}

export interface WpApiErrorBody {
  code: string;
  message: string;
  data?: {
    status?: number;
    params?: Record<string, string>;
    [key: string]: unknown;
  };
}

export interface AuthCredentials {
  username: string;
  password: string;
}

export interface GlobalFlags {
  url?: string;
  username?: string;
  password?: string;
  context: Context;
  format: OutputFormat;
  fields?: string;
  field?: string;
  content?: string;
  color: boolean;
  quiet: boolean;
  debug: boolean;
}

export type Verb = 'list' | 'get' | 'create' | 'update' | 'delete' | 'exists' | 'generate';
