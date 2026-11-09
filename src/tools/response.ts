import type { Response ,  } from 'express'

export const success = function (c: Response, data: any = null, message = 'success', code: number = 200) {
    return c.json({ code, data, message })
}

export const error = function(c: Response, message = '报错了', code: number = 500) {
    return c.json({ code, data: null, message })
}