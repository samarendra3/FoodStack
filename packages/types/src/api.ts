/** Successful response envelope returned by every FoodStack REST endpoint. */
export interface ApiSuccess<T> {
  data: T;
  meta?: ApiMeta;
}

export interface ApiMeta {
  requestId?: string;
  page?: CursorPage;
}

export interface CursorPage {
  nextCursor: string | null;
  hasMore: boolean;
}

/** RFC 9457 Problem Details, extended with a stable machine-readable `code`. */
export interface ApiProblem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  instance?: string;
  requestId?: string;
  errors?: ApiFieldError[];
}

export interface ApiFieldError {
  path: string;
  message: string;
}
