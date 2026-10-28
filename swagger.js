// Swagger 接口文档配置（UI: /api-docs）
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');

const port = process.env.PORT || 3000;

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: '口袋管家 API',
      version: '1.0.0',
      description: '口袋管家接口文档（注册 / 登录 / 用户与游戏账号管理 / 积分计费：工具按 1 点/小时主动上报扣减 + 服务端每日最低消费结算）'
    },
    servers: [
      { url: 'http://localhost:' + port, description: '本地开发' }
    ],
    components: {
      securitySchemes: {
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'connect.sid' },
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: '会员 API 令牌：登录(/api/login)或 /api/token 获取，请求头携带 Authorization: Bearer <token>'
        }
      },
      schemas: {
        User: {
          type: 'object',
          description: '平台用户',
          properties: {
            id: { type: 'integer', example: 1, description: '用户ID' },
            username: { type: 'string', example: 'test001', description: '用户名' },
            plan: { type: 'string', example: '高级版', description: '会员套餐（高级版/尊享版等）' },
            points: { type: 'integer', example: 500, description: '剩余积分（接口返回为整数，内部按 DECIMAL 精确累计后对外取整，兼容客户端 int 字段）' },
            status: { type: 'string', example: '正常', description: '账号状态（正常/已过期等）' }
          }
        },
        Account: {
          type: 'object',
          description: '游戏账号（一个用户可拥有多个）。qqAccessToken / qqOpenid 为账号属性，添加与拉取都会返回',
          properties: {
            id: { type: 'string', example: 'acc-1', description: '账号ID（acc_id，如 acc-1）' },
            profileDir: { type: 'string', example: 'acc-1', description: '配置目录' },
            uid: { type: 'string', example: '12554951429915', description: '游戏UID' },
            name: { type: 'string', example: '逍遥浮尘', description: '游戏角色名' },
            serverId: { type: 'string', example: '4018', description: '区服ID' },
            lastLoginAt: { type: 'integer', example: 1790389116315, description: '最后登录时间（毫秒时间戳）' },
            serverInfoToken: { type: 'string', example: 'NDAxOCx3ZWJnYW1l...', description: '服务器信息token' },
            tokenExpireAt: { type: 'integer', example: 1790391695893000, description: 'token过期时间（毫秒时间戳）' },
            avatar: { type: 'string', example: 'https://warcdn.rivergame.net/...', description: '头像URL' },
            qqAccessToken: { type: 'string', example: '4BC00896E280764DB8557D8094EFE710', description: 'QQ登录access token' },
            qqOpenid: { type: 'string', example: 'BEECD62BD7C7B9E081AFA11D787ACE76', description: 'QQ openid' }
          }
        },
        ApiResult: {
          type: 'object',
          description: '通用返回结果',
          properties: {
            success: { type: 'boolean', example: true, description: '是否成功' },
            message: { type: 'string', example: '操作成功', description: '提示信息' }
          }
        },
        DeductResult: {
          type: 'object',
          description: '工具上报扣费结果（POST /api/points/deduct）',
          properties: {
            success: { type: 'boolean', example: true, description: '是否成功' },
            userId: { type: 'integer', example: 1, description: '用户ID' },
            accountId: { type: 'string', example: 'acc-1', description: '账号ID' },
            deducted: { type: 'number', example: 0.6, description: '实际扣除点数（保留2位小数，余额不足时为实际扣到的金额）' },
            remainingPoints: { type: 'number', example: 599.4, description: '扣除后剩余点数（DECIMAL(10,2)，保留2位小数）' },
            insufficient: { type: 'boolean', example: false, description: '是否余额不足（true=已扣到 0）' }
          }
        },
        PointsLogItem: {
          type: 'object',
          description: '单条扣费流水',
          properties: {
            id: { type: 'integer', example: 1024, description: '流水ID（自增，越大越新）' },
            userId: { type: 'integer', example: 1, description: '用户ID' },
            accountId: { type: 'string', example: 'acc-1', description: '账号ID（daily_min 可空）' },
            amount: { type: 'number', example: 10, description: '扣除点数' },
            type: { type: 'string', enum: ['usage', 'daily_min'], example: 'usage', description: '流水类型：usage=工具上报扣减；daily_min=每日最低消费补足' },
            day: { type: 'string', example: '2026-10-13', description: '结算日期(YYYY-MM-DD)' }
          }
        },
        PointsLogResult: {
          type: 'object',
          description: '扣费流水分页结果（GET /api/points/records）',
          properties: {
            success: { type: 'boolean', example: true, description: '是否成功' },
            userId: { type: 'integer', example: 1, description: '用户ID' },
            page: { type: 'integer', example: 1, description: '当前页码' },
            pageSize: { type: 'integer', example: 20, description: '每页条数' },
            total: { type: 'integer', example: 35, description: '总条数' },
            records: {
              type: 'array',
              description: '扣费流水（倒序，最新在前）',
              items: { $ref: '#/components/schemas/PointsLogItem' }
            }
          }
        },
        PointsPlan: {
          type: 'object',
          description: '扣费计划开关状态（总开关）',
          properties: {
            success: { type: 'boolean', example: true, description: '是否成功' },
            enabled: { type: 'boolean', example: true, description: '扣费计划是否启用（true=工具上报扣费与每日最低消费结算生效）' }
          }
        },
        SettleResult: {
          type: 'object',
          description: '每日最低消费结算结果（POST /api/points/settle）',
          properties: {
            success: { type: 'boolean', example: true, description: '是否成功' },
            day: { type: 'string', example: '2026-10-13', description: '结算日期(YYYY-MM-DD)' },
            dailyMin: { type: 'number', example: 12, description: '每日最低消费点数（来自 settings.billing_daily_minimum，默认 12）' },
            processed: { type: 'integer', example: 13, description: '本次实际补足（扣费）的用户数' },
            totalCharged: { type: 'number', example: 83.5, description: '本次总补足点数（保留2位小数）' },
            details: {
              type: 'array',
              description: '每个被补足用户的明细',
              items: {
                type: 'object',
                properties: {
                  userId: { type: 'integer', example: 12, description: '用户ID' },
                  day: { type: 'string', example: '2026-10-13', description: '结算日期' },
                  beforeTotal: { type: 'number', example: 5, description: '该用户当天已扣总额（usage + 此前 daily_min）' },
                  charged: { type: 'number', example: 3.5, description: '本次补足点数（保留2位小数，余额不足时只扣到 0）' },
                  remainingPoints: { type: 'number', example: 592.0, description: '补足后剩余点数（DECIMAL(10,2)，2位小数）' }
                }
              }
            }
          }
        }
      }
    }
  },
  // 从路由文件中的 @openapi 注释解析接口定义
  apis: ['./routes/*.js']
};

const specs = swaggerJsdoc(options);
module.exports = { swaggerUi, specs };
