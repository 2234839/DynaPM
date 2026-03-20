具有类 serverless 特性的轻量级通用服务管理系统:dynapm
## dynapm 开发

/loop 先检查 TASK.md 中是否有未完成的任务请逐项完成并在充分test验证再继续下一项，如果没有则请请完善当前项目：测试更多代理场景，确保网关程序没有问题，监测并优化程序性能,修改完毕后需要使用 pilot 进行实际运行测试，请自我完善，不要询问我任何事情，也不要切换其他模式（例如 plan mode）
作为网关的测试一定要非常严谨，测试各种可能的情况以及极端情况。
所有文件使用 ts，需要临时运行的使用 node --experimental-strip-types -e xxx.ts 来执行

## TASKS 

[x] 充分测试当前的代理功能是否正确
[x] 创建一个实用的dynam能力演示程序：实现一个运行ts/js的 serveless host（并不属于 dynapm，但是可以被 dynapm 运行，然后请求又可以被这个  serveless host 路由到 对应的 ts文件去执行）：支持用户通过网站访问并编写 ts 上传执行和测试执行