# Error Handling Enhancement Plan

## 1. REST 400 Error Normalization
- Add `Errors` map and `sendHttpError` helper in rest.ts
- Replace all `errorResponse(res, 400, ...)` calls with `sendHttpError(res, Errors.badRequest(...))`
- Same for 404, 401, 500

## 2. AuthError → Proper 401
- In the catch block of handleRequest, check if err is AuthError and use err.statusCode

## 3. (node as any).key
- In graph-engine.ts, line 209 - check if we can use a narrower type
