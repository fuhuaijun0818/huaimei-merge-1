// 服务端身份下发的岗位能力集合。放在独立模块里，避免被 store 覆盖层重建时丢失，
// 也避免各个页面各自按角色名硬编码判断（C-019/C-026 的口径：能力只来自服务端）。
let identityCapabilities = [];

export const setIdentityCapabilities = (value) => {
  identityCapabilities = Array.isArray(value) ? value.map((item) => String(item)) : [];
  return identityCapabilities;
};

export const getIdentityCapabilities = () => [...identityCapabilities];

export const hasIdentityCapability = (capability) => identityCapabilities.includes(String(capability));
