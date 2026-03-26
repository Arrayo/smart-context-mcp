using System;
using System.Collections.Generic;

namespace Example.Services
{
    public interface IUserService
    {
        Guid CreateUser(string email);
    }

    public enum UserRole
    {
        Admin,
        Member
    }

    public record UserDto(Guid Id, string Email);

    public class SampleService : IUserService
    {
        public Guid CreateUser(string email)
        {
            return Guid.NewGuid();
        }

        public void DeleteUser(Guid id)
        {
            // delete logic
        }
    }
}
