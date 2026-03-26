import Foundation
import UIKit

protocol UserServiceProtocol {
    func createUser(email: String) -> UUID
}

enum UserRole {
    case admin
    case member
}

struct UserDto {
    let id: UUID
    let email: String
}

actor SessionManager {
    func validate() -> Bool { return true }
}

class SampleService: UserServiceProtocol {
    func createUser(email: String) -> UUID {
        return UUID()
    }

    func deleteUser(id: UUID) {
        // delete logic
    }
}

func topLevelHelper() -> String {
    return "helper"
}
