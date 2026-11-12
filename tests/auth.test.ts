import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from './helpers/test-app.js';

let ctx: TestApp;

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.close();
});

describe('autenticação (docs/auth-contract.md)', () => {
  it('cadastra, emite cookie HttpOnly e cria categorias padrão', async () => {
    const client = await ctx.client().bootstrap();
    const response = await client.post('/auth/register', {
      name: '  Ana Silva ',
      email: ' ANA.Cadastro@Exemplo.com ',
      password: 'Senha123',
    });
    expect(response.statusCode).toBe(201);
    const user = response.json<{ id: string; name: string; email: string }>();
    expect(Object.keys(user).sort()).toEqual(['email', 'id', 'name']);
    expect(user).toMatchObject({ name: 'Ana Silva', email: 'ana.cadastro@exemplo.com' });
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
    const session = response.cookies.find((cookie) => cookie.name === 'fincore_session');
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe('Lax');

    const me = await client.get('/auth/me');
    expect(me.statusCode).toBe(200);
    expect(me.json<{ email: string }>().email).toBe('ana.cadastro@exemplo.com');

    const categories = await client.get('/categories');
    expect(categories.json<unknown[]>().length).toBe(14);
  });

  it('recusa e-mail duplicado (409) e dados inválidos (422 com errors[])', async () => {
    const client = await ctx.client().bootstrap();
    const body = { name: 'Bia', email: 'dup@exemplo.com', password: 'Senha123' };
    expect((await client.post('/auth/register', body)).statusCode).toBe(201);

    const other = await ctx.client().bootstrap();
    const duplicate = await other.post('/auth/register', body);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: 'EMAIL_ALREADY_REGISTERED', status: 409 });

    const invalid = await other.post('/auth/register', { name: 'B', email: 'x', password: 'abc' });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.headers['content-type']).toContain('application/problem+json');
    const fields = invalid.json<{ errors: { field: string }[] }>().errors.map((e) => e.field);
    expect(fields).toEqual(expect.arrayContaining(['name', 'email', 'password']));
  });

  it('login com mensagem genérica e sessão por cookie', async () => {
    const client = ctx.client();
    const user = await client.register();
    await client.post('/auth/logout');
    expect((await client.get('/auth/me')).statusCode).toBe(401);

    const wrong = await client.post('/auth/login', { email: user.email, password: 'Errada123' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ detail: 'E-mail ou senha inválidos.' });
    const unknown = await client.post('/auth/login', {
      email: 'ninguem@x.com',
      password: 'Errada123',
    });
    expect(unknown.json<{ detail: string }>().detail).toBe('E-mail ou senha inválidos.');

    const ok = await client.post('/auth/login', {
      email: user.email.toUpperCase(),
      password: user.password,
    });
    expect(ok.statusCode).toBe(200);
    expect((await client.get('/auth/me')).statusCode).toBe(200);
  });

  it('exige o header X-XSRF-TOKEN em requisições que alteram estado', async () => {
    const client = ctx.client();
    await client.register();
    client.sendCsrf = false;
    const response = await client.post('/auth/logout');
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'CSRF_TOKEN_INVALID' });

    const fresh = ctx.client(); // sem cookie XSRF-TOKEN ainda
    const login = await fresh.post('/auth/login', { email: 'a@b.com', password: 'x' });
    expect(login.statusCode).toBe(403);
  });

  it('rotas privadas respondem 401 sem sessão', async () => {
    const client = await ctx.client().bootstrap();
    const response = await client.get('/accounts');
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      status: 401,
      type: 'https://fincore.app/problems/unauthorized',
    });
  });

  it('refresh troca o token e invalida o anterior', async () => {
    const client = ctx.client();
    await client.register();
    const before = client.cookies.get('fincore_session');
    expect((await client.post('/auth/refresh')).statusCode).toBe(204);
    const after = client.cookies.get('fincore_session');
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    expect((await client.get('/auth/me')).statusCode).toBe(200);

    const stale = await ctx.client().bootstrap();
    stale.cookies.set('fincore_session', before ?? '');
    expect((await stale.get('/auth/me')).statusCode).toBe(401);
    expect((await stale.post('/auth/refresh')).statusCode).toBe(401);
  });

  it('sessão expira por inatividade', async () => {
    const client = ctx.client();
    await client.register();
    const original = ctx.clock.now;
    try {
      ctx.clock.now = new Date(original.getTime() + 2 * 60 * 60_000);
      expect((await client.get('/auth/me')).statusCode).toBe(401);
    } finally {
      ctx.clock.now = original;
    }
  });

  it('recuperação de senha: 202 sempre, token de uso único, encerra sessões', async () => {
    const client = ctx.client();
    const user = await client.register();
    const anonymous = await ctx.client().bootstrap();

    expect(
      (await anonymous.post('/auth/password/forgot', { email: 'nao@existe.com' })).statusCode,
    ).toBe(202);
    expect(ctx.mails.find((mail) => mail.to === 'nao@existe.com')).toBeUndefined();

    expect((await anonymous.post('/auth/password/forgot', { email: user.email })).statusCode).toBe(
      202,
    );
    const mail = ctx.mails.find((item) => item.to === user.email);
    expect(mail?.link).toContain('/redefinir-senha?token=');
    const token = new URL(mail?.link ?? 'http://x').searchParams.get('token') ?? '';

    const weak = await anonymous.post('/auth/password/reset', { token, newPassword: 'curta' });
    expect(weak.statusCode).toBe(422);

    const reset = await anonymous.post('/auth/password/reset', {
      token,
      newPassword: 'NovaSenha9',
    });
    expect(reset.statusCode).toBe(204);
    expect((await client.get('/auth/me')).statusCode).toBe(401); // sessões encerradas

    const reused = await anonymous.post('/auth/password/reset', {
      token,
      newPassword: 'OutraSenha9',
    });
    expect(reused.statusCode).toBe(400);
    expect(reused.json()).toMatchObject({ code: 'INVALID_RESET_TOKEN' });

    const login = await anonymous.post('/auth/login', {
      email: user.email,
      password: 'NovaSenha9',
    });
    expect(login.statusCode).toBe(200);
  });

  it('troca de senha valida a senha atual e mantém só a sessão corrente', async () => {
    const client = ctx.client();
    const user = await client.register();
    const otherDevice = await ctx.client().bootstrap();
    await otherDevice.post('/auth/login', { email: user.email, password: user.password });
    expect((await otherDevice.get('/auth/me')).statusCode).toBe(200);

    const wrong = await client.post('/auth/password/change', {
      currentPassword: 'Errada123',
      newPassword: 'NovaSenha9',
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ code: 'INVALID_CURRENT_PASSWORD' });

    const ok = await client.post('/auth/password/change', {
      currentPassword: user.password,
      newPassword: 'NovaSenha9',
    });
    expect(ok.statusCode).toBe(204);
    expect((await client.get('/auth/me')).statusCode).toBe(200);
    expect((await otherDevice.get('/auth/me')).statusCode).toBe(401);
  });

  it('responde com X-Request-Id e Problem Details em rota inexistente', async () => {
    const client = await ctx.client().bootstrap();
    const response = await client.get('/nao-existe');
    expect(response.statusCode).toBe(404);
    expect(response.headers['x-request-id']).toBeTruthy();
    expect(response.json()).toMatchObject({
      code: 'ROUTE_NOT_FOUND',
      requestId: response.headers['x-request-id'],
    });
  });
});

describe('rate limiting', () => {
  it('responde 429 com Retry-After após exceder o limite de login', async () => {
    const limited = await createTestApp({ authRateLimitPerMinute: 2 });
    try {
      const client = await limited.client().bootstrap();
      const attempt = () => client.post('/auth/login', { email: 'a@b.com', password: 'Senha123' });
      expect((await attempt()).statusCode).toBe(401);
      expect((await attempt()).statusCode).toBe(401);
      const blocked = await attempt();
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['retry-after']).toBeDefined();
      expect(blocked.json()).toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    } finally {
      await limited.close();
    }
  });
});
