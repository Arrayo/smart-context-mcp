import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCode, extractCodeSymbol } from '../src/tools/smart-read/code.js';
import { summarizePython, extractPythonSymbol } from '../src/tools/smart-read/python.js';
import { summarizeJson } from '../src/tools/smart-read/shared.js';
import { summarizeToml, summarizeYaml } from '../src/tools/smart-read/structured.js';
import { summarizeFallback } from '../src/tools/smart-read/fallback.js';
import {
  summarizeGo,
  summarizeRust,
  summarizeJava,
  summarizeShell,
  summarizeTerraform,
  summarizeDockerfile,
  summarizeSql,
  extractGoSymbol,
  extractRustSymbol,
  extractJavaSymbol,
  summarizeCsharp,
  extractCsharpSymbol,
  summarizeKotlin,
  extractKotlinSymbol,
  summarizePhp,
  extractPhpSymbol,
  summarizeSwift,
  extractSwiftSymbol,
} from '../src/tools/smart-read/additional-languages.js';

const assertContains = (output, pattern, label) => {
  assert.match(output, pattern instanceof RegExp ? pattern : new RegExp(pattern), `${label}: missing ${pattern}`);
};

describe('summarizeCode (JS/TS)', () => {
  const source = `
import { foo } from 'bar';
export const greet = (name) => \`Hello \${name}\`;
export function add(a, b) { return a + b; }
class MyService {}
`;

  it('outline includes imports and exports', () => {
    const result = summarizeCode('test.ts', source, 'outline');
    assertContains(result, /import.*foo.*from.*bar/, 'import');
    assertContains(result, /export const greet/, 'const');
    assertContains(result, /export function add/, 'function');
    assertContains(result, /class MyService/, 'class');
  });

  it('signatures mode works', () => {
    const result = summarizeCode('test.ts', source, 'signatures');
    assertContains(result, /# Signatures/, 'header');
    assertContains(result, /function add/, 'function');
  });

  it('detects React hooks', () => {
    const hookSource = `
import { useState, useEffect } from 'react';
const App = () => { useState(0); useEffect(() => {}, []); };
`;
    const result = summarizeCode('App.tsx', hookSource, 'outline');
    assertContains(result, /useState/, 'useState');
    assertContains(result, /useEffect/, 'useEffect');
  });
});

describe('summarizePython', () => {
  const source = `
import os
from pathlib import Path

API_KEY = "secret"

class UserService:
    def create(self, email: str) -> dict:
        pass

    async def delete(self, user_id: int) -> None:
        pass

def main() -> None:
    pass
`;

  it('outline captures classes, methods, imports, constants', () => {
    const result = summarizePython(source, 'outline');
    assertContains(result, /class UserService/, 'class');
    assertContains(result, /def create/, 'method');
    assertContains(result, /async def delete/, 'async method');
    assertContains(result, /def main/, 'top-level');
    assertContains(result, /import os/, 'import');
    assertContains(result, /const API_KEY/, 'constant');
  });

  it('signatures mode returns compact output', () => {
    const result = summarizePython(source, 'signatures');
    assertContains(result, /class UserService/, 'class');
    assertContains(result, /def main/, 'function');
  });
});

describe('summarizeGo', () => {
  const source = `package api

import (
  "context"
  "net/http"
)

type Server struct {}
type Handler interface {}

func BuildServer() *Server { return &Server{} }
func (s *Server) Handle(ctx context.Context) error { return nil }
`;

  it('extracts package, types, functions, methods', () => {
    const result = summarizeGo(source, 'outline');
    assertContains(result, /package api/, 'package');
    assertContains(result, /type Server struct/, 'struct');
    assertContains(result, /type Handler interface/, 'interface');
    assertContains(result, /func BuildServer/, 'function');
    assertContains(result, /method Handle/, 'method');
  });

  it('signatures includes declarations and imports', () => {
    const result = summarizeGo(source, 'signatures');
    assertContains(result, /# Declarations/, 'header');
    assertContains(result, /func BuildServer/, 'function');
  });
});

describe('summarizeRust', () => {
  const source = `use std::sync::Arc;

pub struct UserService;

impl UserService {
    pub async fn create(&self) -> Result<(), String> { Ok(()) }
}

pub fn build_service() -> Arc<UserService> { Arc::new(UserService) }
`;

  it('extracts structs, impl blocks, methods, functions', () => {
    const result = summarizeRust(source, 'outline');
    assertContains(result, /struct UserService/, 'struct');
    assertContains(result, /impl UserService/, 'impl');
    assertContains(result, /UserService::create/, 'method');
    assertContains(result, /fn build_service/, 'function');
  });
});

describe('summarizeJava', () => {
  const source = `package com.example.service;

import java.util.UUID;

public class SampleService {
  public UUID createUser(String email) {
    return UUID.randomUUID();
  }
}
`;

  it('extracts package, class, methods, imports', () => {
    const result = summarizeJava(source, 'outline');
    assertContains(result, /package com\.example\.service/, 'package');
    assertContains(result, /class SampleService/, 'class');
    assertContains(result, /SampleService::createUser/, 'method');
    assertContains(result, /java\.util\.UUID/, 'import');
  });
});

describe('summarizeShell', () => {
  const source = `#!/usr/bin/env bash
set -euo pipefail

export APP_ENV=production

build_image() {
  docker build -t example/app .
}

deploy() {
  kubectl apply -f k8s.yaml
}
`;

  it('extracts shebang, functions, exports, commands', () => {
    const result = summarizeShell(source, 'outline');
    assertContains(result, /!\/usr\/bin\/env bash/, 'shebang');
    assertContains(result, /function build_image/, 'function');
    assertContains(result, /function deploy/, 'function');
    assertContains(result, /export APP_ENV/, 'export');
  });
});

describe('summarizeTerraform', () => {
  const source = `terraform {
  required_version = ">= 1.0"
}

provider "aws" {
  region = "us-east-1"
}

resource "aws_s3_bucket" "logs" {
  bucket = "my-logs"
}
`;

  it('extracts blocks and assignments', () => {
    const result = summarizeTerraform(source, 'outline');
    assertContains(result, /terraform/, 'terraform block');
    assertContains(result, /provider "aws"/, 'provider');
    assertContains(result, /resource "aws_s3_bucket" "logs"/, 'resource');
    assertContains(result, /bucket/, 'assignment');
  });
});

describe('summarizeDockerfile', () => {
  const source = `FROM node:20-alpine as base
WORKDIR /app
COPY package.json ./
RUN npm ci
CMD ["node", "server.js"]
`;

  it('extracts stages and instructions', () => {
    const result = summarizeDockerfile(source, 'outline');
    assertContains(result, /FROM node:20-alpine/, 'stage');
    assertContains(result, /WORKDIR \/app/, 'instruction');
    assertContains(result, /CMD/, 'cmd');
  });
});

describe('summarizeSql', () => {
  const source = `CREATE TABLE users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL
);

CREATE INDEX idx_users_email ON users(email);

WITH active_users AS (
  SELECT id, email FROM users WHERE active = true
)
SELECT * FROM active_users;
`;

  it('extracts statements and CTEs', () => {
    const result = summarizeSql(source, 'outline');
    assertContains(result, /CREATE TABLE users/, 'create table');
    assertContains(result, /CREATE INDEX/, 'create index');
    assertContains(result, /WITH active_users AS/, 'with/cte');
  });
});

describe('summarizeJson', () => {
  it('outlines object keys with type info', () => {
    const json = JSON.stringify({ name: 'test', deps: { a: 1 }, list: [1, 2, 3] });
    const result = summarizeJson(json, 'outline');
    assertContains(result, /name: test/, 'string value');
    assertContains(result, /deps: object\(1\)/, 'object');
    assertContains(result, /list: array\(3\)/, 'array');
  });
});

describe('summarizeToml', () => {
  const source = `[package]
name = "test"
version = "0.1.0"

[dependencies]
serde = "1.0"
`;

  it('extracts sections and keys', () => {
    const result = summarizeToml(source, 'outline');
    assertContains(result, /\[package\]/, 'section');
    assertContains(result, /\[dependencies\]/, 'section');
    assertContains(result, /package\.name/, 'key');
  });
});

describe('summarizeYaml', () => {
  const source = `name: my-app
services:
  web:
    port: 8080
  db:
    port: 5432
`;

  it('extracts top-level and nested keys', () => {
    const result = summarizeYaml(source, 'outline');
    assertContains(result, /name/, 'top-level');
    assertContains(result, /services/, 'top-level');
    assertContains(result, /web/, 'nested');
    assertContains(result, /port/, 'nested');
  });
});

describe('summarizeFallback', () => {
  it('extracts structural lines from unknown formats', () => {
    const source = `some random text
import something
export const foo = 1;
class Bar {}
nothing here
`;
    const result = summarizeFallback(source, 'outline');
    assertContains(result, /import something/, 'import');
    assertContains(result, /export const foo/, 'export');
    assertContains(result, /class Bar/, 'class');
    assert.ok(!result.includes('some random text'));
  });
});

// ---------------------------------------------------------------------------
// extractSymbol — unit tests for each language
// ---------------------------------------------------------------------------

describe('extractCodeSymbol (JS/TS AST)', () => {
  const source = `import { foo } from 'bar';

export const greet = (name) => \`Hello \${name}\`;

export function add(a, b) {
  return a + b;
}

class MyService {
  run() {}
}
`;

  it('extracts a function declaration by name', () => {
    const result = extractCodeSymbol('test.ts', source, 'add');
    assertContains(result, /function add/, 'function');
    assertContains(result, /return a \+ b/, 'body');
  });

  it('extracts a class declaration by name', () => {
    const result = extractCodeSymbol('test.ts', source, 'MyService');
    assertContains(result, /class MyService/, 'class');
    assertContains(result, /run\(\)/, 'method');
  });

  it('extracts a const declaration by name', () => {
    const result = extractCodeSymbol('test.ts', source, 'greet');
    assertContains(result, /const greet/, 'const');
  });

  it('returns not-found for missing symbol', () => {
    const result = extractCodeSymbol('test.ts', source, 'nope');
    assertContains(result, /Symbol not found/, 'not found');
  });

  it('extracts a class method by name', () => {
    const classSource = `export class UserService {
  createUser(email: string): string {
    return email;
  }

  deleteUser(id: string): void {}
}
`;
    const result = extractCodeSymbol('test.ts', classSource, 'createUser');
    assertContains(result, /createUser/, 'method name');
    assertContains(result, /return email/, 'method body');
    assert.ok(!result.includes('deleteUser'), 'should not include other methods');
  });

  it('extracts an object method by name', () => {
    const objSource = `const config = {
  getPort() {
    return 3000;
  },
  host: 'localhost',
};
`;
    const result = extractCodeSymbol('test.ts', objSource, 'getPort');
    assertContains(result, /getPort/, 'method');
    assertContains(result, /return 3000/, 'body');
  });

  it('extracts an interface method signature', () => {
    const ifaceSource = `interface UserRepo {
  findById(id: string): Promise<User>;
  save(user: User): Promise<void>;
}
`;
    const result = extractCodeSymbol('test.ts', ifaceSource, 'findById');
    assertContains(result, /findById/, 'method');
  });
});

describe('extractPythonSymbol', () => {
  const source = `import os

class UserService:
    def __init__(self, db):
        self.db = db

    def get_user(self, uid):
        return self.db.find(uid)

def build_connection(host, port=5432):
    return {"host": host, "port": port}
`;

  it('extracts a class with all its methods', () => {
    const result = extractPythonSymbol(source, 'UserService');
    assertContains(result, /class UserService/, 'class');
    assertContains(result, /def __init__/, 'init');
    assertContains(result, /def get_user/, 'method');
  });

  it('extracts a standalone function', () => {
    const result = extractPythonSymbol(source, 'build_connection');
    assertContains(result, /def build_connection/, 'function');
    assertContains(result, /host.*port/, 'body');
  });

  it('returns not-found for missing symbol', () => {
    const result = extractPythonSymbol(source, 'missing');
    assertContains(result, /Symbol not found/, 'not found');
  });
});

describe('extractGoSymbol', () => {
  const source = `package api

type Server struct {
  port int
}

func BuildServer() *Server {
  return &Server{port: 8080}
}

func (s *Server) Handle() error {
  return nil
}
`;

  it('extracts a function by name', () => {
    const result = extractGoSymbol(source, 'BuildServer');
    assertContains(result, /func BuildServer/, 'function');
    assertContains(result, /Server\{port: 8080\}/, 'body');
  });

  it('extracts a type by name', () => {
    const result = extractGoSymbol(source, 'Server');
    assertContains(result, /type Server struct/, 'type');
    assertContains(result, /port int/, 'field');
  });

  it('returns not-found for missing symbol', () => {
    const result = extractGoSymbol(source, 'nope');
    assertContains(result, /Symbol not found/, 'not found');
  });

  it('handles multiline function signature', () => {
    const multiSrc = `package api

func BuildServer(
    port int,
    host string,
) *Server {
    return &Server{}
}
`;
    const result = extractGoSymbol(multiSrc, 'BuildServer');
    assertContains(result, /func BuildServer/, 'declaration');
    assertContains(result, /port int/, 'param1');
    assertContains(result, /host string/, 'param2');
    assertContains(result, /return &Server/, 'body');
  });

  it('extracts type alias without capturing next declaration', () => {
    const aliasSrc = `package api

type Alias = string

type Server struct {
  port int
}
`;
    const result = extractGoSymbol(aliasSrc, 'Alias');
    assertContains(result, /type Alias = string/, 'alias');
    assert.ok(!result.includes('Server'), 'type alias must not capture struct below');
  });
});

describe('extractRustSymbol', () => {
  const source = `use std::sync::Arc;

pub struct UserService;

impl UserService {
    pub async fn create(&self) -> Result<(), String> {
        Ok(())
    }
}

pub fn build_service() -> Arc<UserService> {
    Arc::new(UserService)
}
`;

  it('extracts a struct by name', () => {
    const result = extractRustSymbol(source, 'UserService');
    assertContains(result, /struct UserService/, 'struct');
    assert.ok(!result.includes('impl'), 'unit struct must not capture impl block below');
  });

  it('extracts a function by name', () => {
    const result = extractRustSymbol(source, 'build_service');
    assertContains(result, /fn build_service/, 'function');
    assertContains(result, /Arc::new/, 'body');
  });

  it('returns not-found for missing symbol', () => {
    const result = extractRustSymbol(source, 'missing');
    assertContains(result, /Symbol not found/, 'not found');
  });

  it('handles multiline function with brace on next line', () => {
    const multiSrc = `pub fn build_service<T: Clone>(
    config: &Config,
    pool: Pool,
) -> Arc<T>
{
    Arc::new(pool.get())
}
`;
    const result = extractRustSymbol(multiSrc, 'build_service');
    assertContains(result, /fn build_service/, 'declaration');
    assertContains(result, /config: &Config/, 'param');
    assertContains(result, /Arc::new/, 'body');
  });
});

describe('summarizeRust impl brace on next line', () => {
  it('captures methods when impl brace is on the next line', () => {
    const src = `use std::io;

impl UserService
{
    pub fn create(&self) {}
    pub fn delete(&self) {}
}

pub fn standalone() {}
`;
    const result = summarizeRust(src, 'outline');
    assertContains(result, /impl UserService/, 'impl block');
    assertContains(result, /UserService::create/, 'method create');
    assertContains(result, /UserService::delete/, 'method delete');
    assertContains(result, /fn standalone/, 'standalone function');
  });
});

describe('extractJavaSymbol', () => {
  const source = `package com.example;

public class SampleService {
  public UUID createUser(String email) {
    return UUID.randomUUID();
  }

  public void deleteUser(String id) {
    // noop
  }
}
`;

  it('extracts a class by name', () => {
    const result = extractJavaSymbol(source, 'SampleService');
    assertContains(result, /class SampleService/, 'class');
    assertContains(result, /createUser/, 'method1');
    assertContains(result, /deleteUser/, 'method2');
  });

  it('extracts a method by name', () => {
    const result = extractJavaSymbol(source, 'createUser');
    assertContains(result, /createUser/, 'method');
    assertContains(result, /UUID\.randomUUID/, 'body');
  });

  it('returns not-found for missing symbol', () => {
    const result = extractJavaSymbol(source, 'nope');
    assertContains(result, /Symbol not found/, 'not found');
  });

  it('finds declaration, not invocation, when both exist', () => {
    const sourceWithCall = `public class SampleService {
  public void wrapper() {
    createUser("test@example.com");
  }

  public UUID createUser(String email) {
    return UUID.randomUUID();
  }
}
`;
    const result = extractJavaSymbol(sourceWithCall, 'createUser');
    assertContains(result, /public UUID createUser/, 'declaration');
    assert.ok(!result.includes('wrapper'), 'should not include wrapper method');
  });

  it('handles multiline method signature', () => {
    const multiSrc = `public class Svc {
  public UUID createUser(
      String email,
      String name
  ) {
    return UUID.randomUUID();
  }
}
`;
    const result = extractJavaSymbol(multiSrc, 'createUser');
    assertContains(result, /createUser/, 'declaration');
    assertContains(result, /String email/, 'param1');
    assertContains(result, /String name/, 'param2');
    assertContains(result, /UUID\.randomUUID/, 'body');
  });
});

// ---------------------------------------------------------------------------
// C#
// ---------------------------------------------------------------------------

describe('summarizeCsharp', () => {
  const source = `using System;
using System.Collections.Generic;

namespace Example.Services
{
    public interface IUserService
    {
        Guid CreateUser(string email);
    }

    public class SampleService : IUserService
    {
        public Guid CreateUser(string email)
        {
            return Guid.NewGuid();
        }
    }
}
`;

  it('outline includes namespace, interface, class and method', () => {
    const result = summarizeCsharp(source, 'outline');
    assertContains(result, /Example\.Services/, 'namespace');
    assertContains(result, /IUserService/, 'interface');
    assertContains(result, /SampleService/, 'class');
    assertContains(result, /CreateUser/, 'method');
  });

  it('signatures includes declarations and usings', () => {
    const result = summarizeCsharp(source, 'signatures');
    assertContains(result, /SampleService/, 'class');
    assertContains(result, /System/, 'using');
  });
});

describe('extractCsharpSymbol', () => {
  const source = `public class SampleService {
    public Guid CreateUser(string email) {
        return Guid.NewGuid();
    }

    public void DeleteUser(Guid id) {
        // noop
    }
}
`;

  it('extracts a class', () => {
    const result = extractCsharpSymbol(source, 'SampleService');
    assertContains(result, /class SampleService/, 'class');
    assertContains(result, /CreateUser/, 'method');
  });

  it('extracts a method', () => {
    const result = extractCsharpSymbol(source, 'CreateUser');
    assertContains(result, /CreateUser/, 'method');
    assertContains(result, /Guid\.NewGuid/, 'body');
  });

  it('returns not-found for missing symbol', () => {
    assertContains(extractCsharpSymbol(source, 'nope'), /Symbol not found/, 'not found');
  });
});

// ---------------------------------------------------------------------------
// Kotlin
// ---------------------------------------------------------------------------

describe('summarizeKotlin', () => {
  const source = `package com.example

import java.util.UUID

data class UserDto(val id: UUID, val email: String)

class SampleService {
    fun createUser(email: String): UUID {
        return UUID.randomUUID()
    }
}

fun topLevelHelper(): String {
    return "helper"
}
`;

  it('outline includes package, class, data class and functions', () => {
    const result = summarizeKotlin(source, 'outline');
    assertContains(result, /com\.example/, 'package');
    assertContains(result, /UserDto/, 'data class');
    assertContains(result, /SampleService/, 'class');
    assertContains(result, /topLevelHelper/, 'top-level fun');
  });

  it('signatures includes declarations and imports', () => {
    const result = summarizeKotlin(source, 'signatures');
    assertContains(result, /SampleService/, 'class');
    assertContains(result, /java\.util\.UUID/, 'import');
  });
});

describe('extractKotlinSymbol', () => {
  const source = `class SampleService {
    fun createUser(email: String): UUID {
        return UUID.randomUUID()
    }

    fun deleteUser(id: UUID) {
        // noop
    }
}
`;

  it('extracts a class', () => {
    const result = extractKotlinSymbol(source, 'SampleService');
    assertContains(result, /class SampleService/, 'class');
    assertContains(result, /createUser/, 'method');
  });

  it('extracts a function', () => {
    const result = extractKotlinSymbol(source, 'createUser');
    assertContains(result, /createUser/, 'fun');
    assertContains(result, /UUID\.randomUUID/, 'body');
  });

  it('returns not-found for missing symbol', () => {
    assertContains(extractKotlinSymbol(source, 'nope'), /Symbol not found/, 'not found');
  });
});

// ---------------------------------------------------------------------------
// PHP
// ---------------------------------------------------------------------------

describe('summarizePhp', () => {
  const source = `<?php

namespace App\\Services;

use App\\Models\\User;

interface UserServiceContract
{
    public function createUser($email);
}

class SampleService implements UserServiceContract
{
    public function createUser($email)
    {
        return new User($email);
    }
}
`;

  it('outline includes namespace, interface, class and method', () => {
    const result = summarizePhp(source, 'outline');
    assertContains(result, /App\\Services/, 'namespace');
    assertContains(result, /UserServiceContract/, 'interface');
    assertContains(result, /SampleService/, 'class');
    assertContains(result, /createUser/, 'method');
  });

  it('signatures includes declarations and uses', () => {
    const result = summarizePhp(source, 'signatures');
    assertContains(result, /SampleService/, 'class');
    assertContains(result, /App\\Models\\User/, 'use');
  });
});

describe('extractPhpSymbol', () => {
  const source = `<?php
class SampleService
{
    public function createUser($email)
    {
        return new User($email);
    }

    public function deleteUser($id)
    {
        // noop
    }
}
`;

  it('extracts a class', () => {
    const result = extractPhpSymbol(source, 'SampleService');
    assertContains(result, /class SampleService/, 'class');
    assertContains(result, /createUser/, 'method');
  });

  it('extracts a method', () => {
    const result = extractPhpSymbol(source, 'createUser');
    assertContains(result, /createUser/, 'function');
    assertContains(result, /new User/, 'body');
  });

  it('returns not-found for missing symbol', () => {
    assertContains(extractPhpSymbol(source, 'nope'), /Symbol not found/, 'not found');
  });
});

// ---------------------------------------------------------------------------
// Swift
// ---------------------------------------------------------------------------

describe('summarizeSwift', () => {
  const source = `import Foundation

protocol UserServiceProtocol {
    func createUser(email: String) -> UUID
}

struct UserDto {
    let id: UUID
    let email: String
}

class SampleService: UserServiceProtocol {
    func createUser(email: String) -> UUID {
        return UUID()
    }
}
`;

  it('outline includes protocol, struct, class and func', () => {
    const result = summarizeSwift(source, 'outline');
    assertContains(result, /UserServiceProtocol/, 'protocol');
    assertContains(result, /UserDto/, 'struct');
    assertContains(result, /SampleService/, 'class');
    assertContains(result, /createUser/, 'func');
  });

  it('signatures includes declarations and imports', () => {
    const result = summarizeSwift(source, 'signatures');
    assertContains(result, /SampleService/, 'class');
    assertContains(result, /Foundation/, 'import');
  });
});

describe('extractSwiftSymbol', () => {
  const source = `class SampleService {
    func createUser(email: String) -> UUID {
        return UUID()
    }

    func deleteUser(id: UUID) {
        // noop
    }
}
`;

  it('extracts a class', () => {
    const result = extractSwiftSymbol(source, 'SampleService');
    assertContains(result, /class SampleService/, 'class');
    assertContains(result, /createUser/, 'method');
  });

  it('extracts a function', () => {
    const result = extractSwiftSymbol(source, 'createUser');
    assertContains(result, /createUser/, 'func');
    assertContains(result, /UUID\(\)/, 'body');
  });

  it('returns not-found for missing symbol', () => {
    assertContains(extractSwiftSymbol(source, 'nope'), /Symbol not found/, 'not found');
  });
});
