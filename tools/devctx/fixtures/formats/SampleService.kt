package com.example.service

import java.util.UUID

interface UserService {
    fun createUser(email: String): UUID
}

enum class UserRole {
    ADMIN, MEMBER
}

data class UserDto(val id: UUID, val email: String)

object ServiceRegistry {
    fun register(service: UserService) {}
}

class SampleService : UserService {
    override fun createUser(email: String): UUID {
        return UUID.randomUUID()
    }

    fun deleteUser(id: UUID) {
        // delete logic
    }
}

fun topLevelHelper(): String {
    return "helper"
}
