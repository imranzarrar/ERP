export const debugAuth = () => {
  console.log("--- Auth Diagnostics ---");
  console.log("document.cookie:", document.cookie);
  console.log("localStorage 'erp_session_user_id':", localStorage.getItem('erp_session_user_id'));
  console.log("------------------------");
};
