/** Compatibility entry points. New callers use entity APIs. */
export { authorizeAvatarUpload, setAvatar } from './avatars';
export { setApprovalEmail as saveApprovalEmail, setName as saveCompanyName } from './companies';
export { setRole as savePersonalRole } from './memberships';
export { setName as savePersonalName } from './profiles';
