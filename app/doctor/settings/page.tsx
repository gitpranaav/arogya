"use client";

import { useEffect, useState } from "react";

import { Button } from "@/src/components/ui/Button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/Card";
import { Input } from "@/src/components/ui/Input";

export default function DoctorSettingsPage() {
  const [receptionistPassword, setReceptionistPassword] = useState("");
  const [clinicName, setClinicName] = useState("");
  const [clinicAddress, setClinicAddress] = useState("");
  const [clinicPhone, setClinicPhone] = useState("");
  const [registrationNumber, setRegistrationNumber] = useState("");
  const [doctorName, setDoctorName] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const response = await fetch("/api/doctor/settings");
      const data = await response.json();
      if (cancelled || !response.ok) return;
      setClinicName(String(data.clinic_name ?? ""));
      setClinicAddress(String(data.clinic_address ?? ""));
      setClinicPhone(String(data.clinic_phone ?? ""));
      setRegistrationNumber(String(data.registration_number ?? ""));
      setDoctorName(String(data.doctor_name ?? ""));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    setError(null);
    setMessage(null);
    setLoading(true);
    const response = await fetch("/api/doctor/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clinic_name: clinicName,
        clinic_address: clinicAddress,
        clinic_phone: clinicPhone,
        registration_number: registrationNumber,
        doctor_name: doctorName,
      }),
    });
    const data = await response.json();
    setLoading(false);
    if (!response.ok) return setError(data.error ?? "Failed to update password");
    setMessage("Clinic settings updated.");
  };

  const savePassword = async () => {
    setError(null);
    setMessage(null);
    setLoading(true);
    const response = await fetch("/api/doctor/receptionist-password", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ receptionist_password: receptionistPassword }),
    });
    const data = await response.json();
    setLoading(false);
    if (!response.ok) return setError(data.error ?? "Failed to update password");
    setReceptionistPassword("");
    setMessage("Receptionist password updated.");
  };

  return (
    <div className="max-w-2xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
          <CardDescription>Manage clinic identity for printed prescriptions and access preferences.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Input label="Clinic / hospital name" value={clinicName} onChange={(e) => setClinicName(e.target.value)} />
            <Input label="Doctor name" value={doctorName} onChange={(e) => setDoctorName(e.target.value)} />
            <Input label="Clinic phone number" value={clinicPhone} onChange={(e) => setClinicPhone(e.target.value)} />
            <Input label="Registration number" value={registrationNumber} onChange={(e) => setRegistrationNumber(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Input
              label="Clinic / hospital address"
              value={clinicAddress}
              onChange={(e) => setClinicAddress(e.target.value)}
              placeholder="Street, area, city, state"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button loading={loading} onClick={save}>
              Save clinic details
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Receptionist Access</CardTitle>
          <CardDescription>Update the receptionist login password.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Input
              label="Receptionist password"
              type="password"
              value={receptionistPassword}
              onChange={(e) => setReceptionistPassword(e.target.value)}
              placeholder="Minimum 10 characters"
              minLength={10}
              maxLength={256}
            />
            <p className="text-xs text-[hsl(var(--text-muted))]">
              Receptionist logs in using your email + this password at <code>/receptionist/login</code>.
            </p>
          </div>
          {error ? <p className="text-xs text-[hsl(var(--danger))]">{error}</p> : null}
          {message ? <p className="text-xs text-[hsl(var(--success))]">{message}</p> : null}
          <Button loading={loading} onClick={savePassword} disabled={receptionistPassword.trim().length < 10}>
            Save
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

