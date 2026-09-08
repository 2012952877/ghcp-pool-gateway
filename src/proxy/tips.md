1. 删除gh login后，gh上会出现在suspended页面。所以不建议删除，只建议挂起。
2. IDENTITY_HEADER_REQUIRED 等于 false 时，proxy会用 default 用户，即使设置了false，但是带了身份头，就会用对应的身份头用户。