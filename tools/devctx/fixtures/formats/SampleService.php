<?php

namespace App\Services;

use App\Models\User;
use App\Contracts\UserServiceInterface;

interface UserServiceContract
{
    public function createUser($email);
}

trait Loggable
{
    public function log($message) {}
}

abstract class UserRole
{
    const ADMIN = 'admin';
    const MEMBER = 'member';
}

class SampleService implements UserServiceContract
{
    use Loggable;

    public function createUser($email)
    {
        return new User($email);
    }

    public function deleteUser($id)
    {
        // delete logic
    }
}

function helperFunction()
{
    return "helper";
}
